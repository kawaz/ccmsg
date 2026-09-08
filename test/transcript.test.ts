import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { PROTOCOL_VERSION, TOPIC_SCHEMAS, validationErrors } from "@ccmsg/protocol";
import { classify, Sessions } from "../src/sessions/index.ts";
import { Topics } from "../src/topics/index.ts";
import { type TranscriptFacts, TranscriptFold, Transcripts } from "../src/transcript/index.ts";
import { connAs, greeting, SELF, SID, TestConn } from "./frames.ts";

const TOPIC = `transcript:${SID}`;
/** Fast enough that a test can wait for the backstop rather than the watch,
 * which is what makes the reading observable without depending on FSEvents. */
const POLL_MS = 5;

const roots: string[] = [];
const running: Transcripts[] = [];
afterEach(() => {
  // A tail left running is a real file watch and a real timer.
  for (const domain of running.splice(0)) domain.stopAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway transcript under the OS temp dir. */
function transcript(lines: readonly object[] = []) {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-transcript-"));
  roots.push(root);
  const path = join(root, `${SID}.jsonl`);
  writeFileSync(path, jsonl(lines));
  return {
    path,
    append(...rows: object[]) {
      appendFileSync(path, jsonl(rows));
    },
    /** Half a record, as a writer mid-line leaves the file. */
    appendRaw(text: string) {
      appendFileSync(path, text);
    },
  };
}

function jsonl(rows: readonly object[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

interface Published {
  topic: string;
  data: Record<string, unknown>;
}

function domain(path: string | undefined) {
  const published: Published[] = [];
  const facts: string[] = [];
  const transcripts = new Transcripts({
    self: SELF,
    pathOf: () => path,
    publish: (topic, data) => published.push({ topic, data: data as Record<string, unknown> }),
    onFacts: (sid) => facts.push(sid),
    pollMs: POLL_MS,
  });
  running.push(transcripts);
  return { transcripts, published, facts };
}

/** Wait for the tail's confirmation poll to have read what was just written.
 * The watch usually gets there first; the poll is what bounds the wait. */
async function settled(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await Bun.sleep(POLL_MS);
  }
  expect(check()).toBe(true);
}

const NOW = Date.parse("2026-09-08T10:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** A row the model produced. Anything without `isApiErrorMessage` and with a
 * real model name is the agent answering, which clears an error. */
const answer = (offsetMs = 0) => ({
  type: "assistant",
  timestamp: at(offsetMs),
  message: { model: "claude-fable-5", content: [{ type: "text", text: "here you go" }] },
});

/** A row the harness wrote about a turn that stopped. */
const apiError = (text: string, offsetMs = 0) => ({
  type: "assistant",
  isApiErrorMessage: true,
  timestamp: at(offsetMs),
  message: { model: "<synthetic>", content: [{ type: "text", text }] },
});

const prompt = (text: string, offsetMs = 0, extra: object = {}) => ({
  type: "user",
  timestamp: at(offsetMs),
  message: { role: "user", content: text },
  ...extra,
});

describe("the fold (§3.3)", () => {
  /** One fold, one table: each case is the rows in order and what the fold
   * says once it has read them. */
  const cases: {
    name: string;
    rows: object[];
    error?: string;
    input?: number;
  }[] = [
    { name: "a transcript that says nothing", rows: [{ type: "system", subtype: "init" }] },
    {
      name: "a turn that stopped on an api error",
      rows: [prompt("do the thing"), apiError("Prompt is too long", 1)],
      error: "Prompt is too long",
      input: NOW,
    },
    {
      name: "an error the agent has since answered past",
      rows: [apiError("API Error: 500", 1), answer(2)],
      input: undefined,
    },
    {
      name: "a person typing after the error, which does not resolve it",
      rows: [apiError("Prompt is too long", 1), prompt("please continue", 2)],
      error: "Prompt is too long",
      input: NOW + 2,
    },
    {
      name: "the harness's own synthetic row, which is not the agent answering",
      rows: [
        apiError("Please run /login", 1),
        {
          type: "assistant",
          timestamp: at(2),
          message: {
            model: "<synthetic>",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
      ],
      error: "Please run /login",
    },
    {
      name: "a subagent failing, which does not stop the session",
      rows: [{ ...apiError("API Error: 500", 1), isSidechain: true }],
    },
    {
      name: "the newest of a retry burst",
      rows: [apiError("API Error: 500", 1), apiError("API Error: 529", 2)],
      error: "API Error: 529",
    },
    {
      name: "an injected user row, which is not a person speaking",
      rows: [prompt("do the thing"), prompt("<skill body>", 5, { isMeta: true })],
      input: NOW,
    },
    {
      name: "a harness-raised prompt",
      rows: [prompt("do the thing"), prompt("run the hook", 5, { promptSource: "system" })],
      input: NOW,
    },
    {
      name: "a system notification, which carries no marker of its own",
      rows: [
        prompt("do the thing"),
        prompt("[SYSTEM NOTIFICATION - NOT USER INPUT] a task finished", 5),
      ],
      input: NOW,
    },
    {
      name: "a subagent being prompted by its parent",
      rows: [prompt("do the thing"), { ...prompt("go and look", 5), isSidechain: true }],
      input: NOW,
    },
    {
      name: "a prompt typed alongside an attachment",
      rows: [
        {
          type: "user",
          timestamp: at(3),
          message: {
            role: "user",
            content: [
              { type: "image", source: {} },
              { type: "text", text: "what is in this" },
            ],
          },
        },
      ],
      input: NOW + 3,
    },
    {
      name: "a tool answering, which is a user row with nothing a person typed",
      rows: [
        prompt("do the thing"),
        {
          type: "user",
          timestamp: at(5),
          message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
        },
      ],
      input: NOW,
    },
    { name: "a half-written record", rows: [], error: undefined },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const fold = new TranscriptFold();
      for (const row of testCase.rows) fold.line(JSON.stringify(row));
      // A line that is not a whole record must not throw or count.
      fold.line('{"type":"assist');
      expect(fold.facts.api_error?.text).toEqual(testCase.error);
      expect(fold.facts.last_user_input_at).toEqual(testCase.input);
    });
  }

  test("an error states when it happened, in the contract's spelling", () => {
    const fold = new TranscriptFold();
    fold.line(JSON.stringify(apiError("Prompt is too long", 7)));
    expect(fold.facts.api_error?.occurred_at).toBe(NOW + 7);
  });

  test("a fold that has read an error is what makes a live session Waiting (§5.2)", () => {
    const fold = new TranscriptFold();
    fold.line(JSON.stringify(apiError("Prompt is too long")));
    const stopped = fold.facts.api_error !== undefined;
    expect(classify({ connected: true, api_error_stopped: stopped })).toBe("waiting");
    expect(classify({ connected: true })).toBe("live");
  });
});

describe("the transcript topic (§6.2)", () => {
  test("what is appended arrives with the offsets that place it", async () => {
    const file = transcript([prompt("first")]);
    const { transcripts, published } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));
    const before = transcripts.snapshot(TOPIC)[0]?.data as { size: number };

    const added = jsonl([answer(1)]);
    file.append(answer(1));
    await settled(() => published.length > 0);

    const frame = published[0];
    expect(frame?.topic).toBe(TOPIC);
    expect(frame?.data["lines"]).toEqual([JSON.stringify(answer(1))]);
    // The subscription's snapshot said where the file ended; the frame after
    // it begins exactly there, so nothing is read twice and nothing is skipped.
    expect(frame?.data["start"]).toBe(before.size);
    expect(frame?.data["end"]).toBe(before.size + Buffer.byteLength(added));
    expect(frame?.data["size"]).toBe(before.size + Buffer.byteLength(added));
  });

  test("a record still being written waits for its end", async () => {
    const file = transcript();
    const { transcripts, published } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));

    file.appendRaw('{"type":"assistant","mess');
    await Bun.sleep(POLL_MS * 4);
    expect(published).toEqual([]);

    file.appendRaw(`age":{"model":"m","content":[]},"timestamp":"${at(1)}"}\n`);
    await settled(() => published.length > 0);
    const lines = published[0]?.data["lines"] as string[];
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ type: "assistant" });
    expect(published[0]?.data["start"]).toBe(0);
  });

  test("the frames pass the contract", async () => {
    const file = transcript([prompt("first")]);
    const { transcripts, published } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));
    const snapshot = transcripts.snapshot(TOPIC)[0]?.data;
    file.append(answer(1));
    await settled(() => published.length > 0);

    const schema = TOPIC_SCHEMAS.transcript;
    for (const data of [snapshot, published[0]?.data]) {
      expect(validationErrors(schema, { ev: "topic", topic: TOPIC, instance: SELF, data })).toEqual(
        [],
      );
    }
  });

  test("a transcript replaced under the tail is read from its beginning", async () => {
    const file = transcript([prompt("first"), apiError("Prompt is too long", 1)]);
    const { transcripts, published, facts } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.facts(SID).api_error !== undefined);

    writeFileSync(file.path, jsonl([prompt("a fresh start", 2)]));
    await settled(() => published.length > 0);
    expect(transcripts.facts(SID).api_error).toBeUndefined();
    expect(transcripts.facts(SID).last_user_input_at).toBe(NOW + 2);
    expect(published[0]?.data["start"]).toBe(0);
    expect(facts.length).toBeGreaterThan(0);
  });

  test("a session that never said where its transcript is is not followed", () => {
    const { transcripts } = domain(undefined);
    transcripts.hold(SID);
    expect(transcripts.following(SID)).toBe(false);
    expect(transcripts.snapshot(TOPIC)).toEqual([]);
    expect(transcripts.facts(SID)).toEqual({});
  });
});

describe("the tail runs while somebody is listening (§6.3)", () => {
  test("subscribing starts it and the last unsubscribe stops it", async () => {
    const file = transcript([prompt("first")]);
    const { transcripts } = domain(file.path);
    const hub = new Topics(SELF, new Set());
    hub.attach("transcript", transcripts);
    const watcher = connAs("user");
    const second = connAs("user");

    expect(transcripts.following(SID)).toBe(false);
    expect(hub.subscribe(watcher, TOPIC)).toBe("ok");
    await settled(() => transcripts.following(SID));

    expect(hub.subscribe(second, TOPIC)).toBe("ok");
    hub.unsubscribe(watcher, TOPIC);
    expect(transcripts.following(SID)).toBe(true);

    hub.unsubscribe(second, TOPIC);
    expect(transcripts.following(SID)).toBe(false);
  });

  test("a hold outlives the subscription that shared it", async () => {
    const file = transcript([prompt("first")]);
    const { transcripts } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));
    transcripts.start(TOPIC);
    transcripts.stop(TOPIC);
    expect(transcripts.following(SID)).toBe(true);
    transcripts.release(SID);
    expect(transcripts.following(SID)).toBe(false);
  });

  test("the subscriber is told where the transcript ends, in the same turn", () => {
    // The snapshot goes out with the subscribe, before anything the tail does
    // asynchronously: a size read later would be zero here, and every byte
    // already in the file would then look appended to whoever stitched the
    // frames onto it.
    const file = transcript([prompt("first")]);
    const { transcripts } = domain(file.path);
    const hub = new Topics(SELF, new Set());
    hub.attach("transcript", transcripts);
    const watcher = new TestConn({ state: "settled", role: "user", sid: SID });
    hub.subscribe(watcher, TOPIC);
    watcher.flush();
    const frame = watcher.topics()[0] as { data: Record<string, unknown> };
    expect(frame.data["size"]).toBe(Buffer.byteLength(jsonl([prompt("first")])));
    expect(frame.data["lines"]).toBeUndefined();
  });
});

describe("one fold, and only one (M5)", () => {
  /** The harness's own vocabulary: a file that names any of these is reading a
   * transcript record. */
  const RECORD_FIELDS = /isApiErrorMessage|isSidechain|isMeta|promptSource|"assistant"/;
  const SRC = new URL("../src/", import.meta.url).pathname;

  test("no transcript record is interpreted outside src/transcript/", async () => {
    const offenders: string[] = [];
    for (const path of new Glob("**/*.ts").scanSync(SRC)) {
      if (path.startsWith("transcript/")) continue;
      const source = await Bun.file(SRC + path).text();
      if (RECORD_FIELDS.test(source)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test("the scan would notice a second reading", async () => {
    const fold = await Bun.file(`${SRC}transcript/fold.ts`).text();
    expect(RECORD_FIELDS.test(fold)).toBe(true);
  });
});

describe("what the fold settles reaches the sessions domain (§5.1)", () => {
  test("the api error classifies, and the human input orders", () => {
    const root = mkdtempSync(join(tmpdir(), "ccmsg-transcript-sessions-"));
    roots.push(root);
    const facts: TranscriptFacts = {
      api_error: { text: "Prompt is too long", occurred_at: NOW },
      last_user_input_at: NOW - 1000,
    };
    const sessions = new Sessions({
      self: SELF,
      configHome: root,
      stateDir: join(root, "state"),
      capabilities: [],
      version: "test",
      startedAt: NOW,
      publish: () => {},
      transcript: { facts: () => facts },
    });
    // Under the config home's `projects/`, which is the only place a greeting's
    // transcript path is taken from (M6).
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(join(root, "projects", "t.jsonl"), "");
    const transcript = realpathSync(join(root, "projects", "t.jsonl"));
    const conn = greeting();
    sessions.hello({
      conn,
      args: {
        protocol_version: PROTOCOL_VERSION,
        role: "session",
        sid: SID,
        transcript_path: transcript,
      },
    } as unknown as Parameters<typeof sessions.hello>[0]);

    expect(sessions.inputs(SID).api_error_stopped).toBe(true);
    expect(sessions.classify(SID)).toBe("waiting");
    expect(sessions.peers().peers[0]?.last_user_input_at).toBe(NOW - 1000);
    expect(sessions.transcriptPath(SID)).toBe(transcript);
  });
});
