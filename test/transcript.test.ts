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
import { isLive, classify, Sessions, sessionStatusOf } from "../src/sessions/index.ts";
import { Topics } from "../src/topics/index.ts";
import {
  FOLD_TAIL_BYTES,
  ITEMS_SNAPSHOT,
  NO_FACTS,
  type TranscriptFacts,
  TranscriptFiles,
  TranscriptFold,
  Transcripts,
  readSlice,
} from "../src/transcript/index.ts";
import { connAs, greeting, SELF, SELF_ENDPOINT, SID, TestConn } from "./frames.ts";
import { unthrottled } from "./clock.ts";

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

  test("what answered last is the last turn's, not the first's", () => {
    const turn = (model: string, effort: string | undefined, offsetMs: number) => ({
      type: "assistant",
      timestamp: at(offsetMs),
      message: { model, content: [{ type: "text", text: "here you go" }] },
      ...(effort === undefined ? {} : { effort }),
    });
    const fold = new TranscriptFold();
    fold.line(JSON.stringify(turn("claude-fable-5", "low", 1)));
    expect(fold.facts).toMatchObject({ model: "claude-fable-5", effort: "low" });
    // `/model` and `/effort` mid-session: the newest row is what the session
    // must resume as, and each is read off the row that states it.
    fold.line(JSON.stringify(turn("claude-opus-5", "xhigh", 2)));
    expect(fold.facts).toMatchObject({ model: "claude-opus-5", effort: "xhigh" });
    // Neither a subagent's model nor the harness's own synthetic row is the
    // session answering.
    fold.line(JSON.stringify({ ...turn("claude-haiku-4-5", "low", 3), isSidechain: true }));
    fold.line(JSON.stringify(apiError("Prompt is too long", 4)));
    expect(fold.facts).toMatchObject({ model: "claude-opus-5", effort: "xhigh" });
    // A turn that names no effort has none to report, rather than keeping what
    // an older turn ran as.
    fold.line(JSON.stringify(turn("claude-opus-5", undefined, 5)));
    expect(fold.facts.effort).toBeUndefined();
  });

  test("a fold that has read an error is what makes a live session Waiting (§5.2)", () => {
    const fold = new TranscriptFold();
    fold.line(JSON.stringify(apiError("Prompt is too long")));
    const stopped = fold.facts.api_error !== undefined;
    expect(classify({ connected: true, api_error_stopped: stopped })).toBe("waiting");
    expect(classify({ connected: true })).toBe("live");
  });
});

describe("a transcript that is not written yet", () => {
  test("following one starts before the file exists, and reads it once it does", async () => {
    // What a session names when it greets at its very start: the harness has
    // not created the file, and it is still where this session's transcript
    // will be. The tail waits for it rather than deciding there is nothing.
    const root = mkdtempSync(join(tmpdir(), "ccmsg-transcript-"));
    roots.push(root);
    const path = join(root, `${SID}.jsonl`);
    const { transcripts, facts } = domain(path);

    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));
    expect(facts).toEqual([]);

    writeFileSync(path, jsonl([prompt("the first thing typed")]));
    await settled(() => facts.length > 0);
    expect(transcripts.facts(SID).last_user_input_at).toBe(NOW);
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
    expect(transcripts.facts(SID)).toEqual(NO_FACTS);
  });
});

describe("the tail runs while somebody is listening (§6.3)", () => {
  test("subscribing starts it and the last unsubscribe stops it", async () => {
    const file = transcript([prompt("first")]);
    const { transcripts } = domain(file.path);
    const hub = new Topics(SELF, new Set(), undefined, unthrottled());
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
    const hub = new Topics(SELF, new Set(), undefined, unthrottled());
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
   * transcript record. Every kind of record the fold reads is represented, so
   * a second reading of any of them is caught rather than only a second reading
   * of the error state. */
  const RECORD_FIELDS =
    /isApiErrorMessage|isSidechain|isMeta|promptSource|"assistant"|toolUseResult|tool_use_id|"tool_use"|"queue-operation"|teammate-message|task_reminder/;
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
      ...NO_FACTS,
      api_error: { text: "Prompt is too long", occurred_at: NOW },
      last_user_input_at: NOW - 1000,
    };
    const sessions = new Sessions({
      harness: "claude",
      self: SELF,
      endpoint: SELF_ENDPOINT,
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
    void sessions.hello({
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
    expect(sessions.peerRows().filter(isLive)[0]?.last_user_input_at).toBe(NOW - 1000);
    expect(sessions.transcriptPath(SID)).toBe(transcript);
  });
});

/** The rest of what one line can settle: the same fold, the same pass, the
 * fields a status frame is built from (§3.3, M5). */
describe("what else the fold settles", () => {
  const call = (id: string, name: string, input: object, offsetMs = 0, extra: object = {}) => ({
    type: "assistant",
    timestamp: at(offsetMs),
    message: { model: "claude-fable-5", content: [{ type: "tool_use", id, name, input }] },
    ...extra,
  });

  const result = (id: string, value: object, offsetMs = 0, extra: object = {}) => ({
    type: "user",
    timestamp: at(offsetMs),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, ...extra }] },
    toolUseResult: value,
  });

  const attachment = (value: object, offsetMs = 0) => ({
    type: "attachment",
    timestamp: at(offsetMs),
    attachment: value,
  });

  const notification = (taskId: string, status: string, offsetMs = 0) => ({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: at(offsetMs),
    content: `<task-notification><task-id>${taskId}</task-id><status>${status}</status></task-notification>`,
  });

  const cases: { name: string; rows: object[]; want: object }[] = [
    {
      name: "a transcript that declared nothing says so with empty lists",
      rows: [answer()],
      want: {
        named_files: [],
        todos: [],
        teammates: [],
        background: [],
        workflows: [],
        agent_tree: { teammates: [], agents: [], workflows: [] },
      },
    },
    {
      name: "a file tool names its file on the call, before any result",
      rows: [call("t1", "Read", { file_path: "/tmp/ccmsg-fold/read.txt" })],
      want: { named_files: [{ path: "/tmp/ccmsg-fold/read.txt", origin: "tool" }] },
    },
    {
      name: "a relative path names nothing, since no surface is spelled that way",
      rows: [call("t1", "Read", { file_path: "notes.txt" })],
      want: { named_files: [] },
    },
    {
      name: "an edited file arrives as an attachment",
      rows: [attachment({ type: "edited_text_file", filename: "/tmp/ccmsg-fold/edited.txt" })],
      want: { named_files: [{ path: "/tmp/ccmsg-fold/edited.txt", origin: "attachment" }] },
    },
    {
      name: "a path named both ways keeps the origin it was first seen with",
      rows: [
        call("t1", "Write", { file_path: "/tmp/ccmsg-fold/both.txt" }),
        attachment({ type: "edited_text_file", filename: "/tmp/ccmsg-fold/both.txt" }, 1),
      ],
      want: { named_files: [{ path: "/tmp/ccmsg-fold/both.txt", origin: "tool" }] },
    },
    {
      name: "a subagent's read names the file, and its spawn is not the session's child",
      rows: [
        call("t1", "Read", { file_path: "/tmp/ccmsg-fold/sub.txt" }, 0, { isSidechain: true }),
        call("t2", "Agent", { description: "deeper" }, 1, { isSidechain: true }),
        result("t2", { agentId: "a-deep", isAsync: true }, 2),
      ],
      want: {
        named_files: [{ path: "/tmp/ccmsg-fold/sub.txt", origin: "tool" }],
        background: [],
        agent_tree: { teammates: [], agents: [], workflows: [] },
      },
    },
    {
      name: "a monitor is a background task",
      rows: [
        call("t1", "Monitor", { description: "errors in deploy.log" }),
        result("t1", { taskId: "m-1", persistent: true }, 1),
      ],
      want: {
        background: [
          {
            task_id: "m-1",
            kind: "monitor",
            description: "errors in deploy.log",
            status: "running",
            started_at: NOW,
          },
        ],
      },
    },
    {
      name: "a foreground command is the turn, not a task",
      rows: [call("t1", "Bash", { description: "list files" }), result("t1", { stdout: "" }, 1)],
      want: { background: [] },
    },
    {
      name: "a backgrounded command is a task",
      rows: [
        call("t1", "Bash", { description: "watch the build", run_in_background: true }),
        result("t1", { backgroundTaskId: "b-1" }, 1),
      ],
      want: { background: [{ task_id: "b-1", kind: "bash", status: "running" }] },
    },
    {
      name: "a spawned agent is a task and a node of the tree, from one result",
      rows: [
        call("t1", "Agent", { description: "survey the code", subagent_type: "Explore" }),
        result("t1", { agentId: "a-1", isAsync: true, resolvedModel: "claude-opus-5" }, 1),
      ],
      want: {
        background: [{ task_id: "a-1", kind: "agent", agent_type: "Explore", status: "running" }],
        agent_tree: {
          teammates: [],
          agents: [
            {
              agent_id: "a-1",
              kind: "subagent",
              spawn_depth: 0,
              state: "running",
              agent_type: "Explore",
              description: "survey the code",
              model: "claude-opus-5",
              children: [],
            },
          ],
          workflows: [],
        },
      },
    },
    {
      name: "an agent waited for has already ended by the time its result is written",
      rows: [
        call("t1", "Agent", { description: "one question" }),
        result("t1", { agentId: "a-2", status: "completed" }, 1),
      ],
      want: { background: [{ task_id: "a-2", status: "completed", ended_at: NOW }] },
    },
    {
      name: "a notification ends the task it names",
      rows: [
        call("t1", "Monitor", { description: "watch" }),
        result("t1", { taskId: "m-1" }, 1),
        notification("m-1", "completed", 2),
      ],
      want: { background: [{ task_id: "m-1", status: "completed", ended_at: NOW + 2 }] },
    },
    {
      name: "a notification quoting the tags in its summary does not end anything else",
      rows: [
        call("t1", "Monitor", { description: "watch" }),
        result("t1", { taskId: "m-1" }, 1),
        {
          type: "queue-operation",
          operation: "enqueue",
          timestamp: at(2),
          content:
            "<task-notification><task-id>other</task-id><status>completed</status>" +
            "<summary><task-id>m-1</task-id><status>failed</status></summary></task-notification>",
        },
      ],
      want: { background: [{ task_id: "m-1", status: "running" }] },
    },
    {
      name: "a call that failed started nothing",
      rows: [
        call("t1", "Monitor", { description: "watch" }),
        result("t1", { taskId: "m-1" }, 1, { is_error: true }),
      ],
      want: { background: [] },
    },
    {
      name: "a teammate is spawned, spoken to, and answers",
      rows: [
        call("t1", "Agent", { name: "researcher" }),
        result(
          "t1",
          {
            status: "teammate_spawned",
            name: "researcher",
            agent_id: "tm-1",
            agent_type: "Explore",
            color: "blue",
            model: "claude-sonnet-5",
            team_name: "the team",
          },
          1,
        ),
        call("t2", "SendMessage", { to: "researcher" }, 2),
        result("t2", { success: true }, 3),
        {
          type: "user",
          timestamp: at(4),
          message: {
            role: "user",
            content:
              '<teammate-message teammate_id="researcher" color="blue">done</teammate-message>',
          },
        },
      ],
      want: {
        teammates: [
          {
            name: "researcher",
            spawned: true,
            state: "active",
            agent_type: "Explore",
            color: "blue",
            model: "claude-sonnet-5",
            spawned_at: NOW,
            last_sent_at: NOW + 2,
            last_received_at: NOW + 4,
          },
        ],
        agent_tree: {
          teammates: [
            {
              agent_id: "tm-1",
              teammate_name: "researcher",
              kind: "teammate",
              spawn_depth: 0,
              state: "active",
              team_name: "the team",
              last_activity_at: NOW + 4,
              children: [],
            },
          ],
          agents: [],
          workflows: [],
        },
      },
    },
    {
      name: "a teammate saying it is idle is idle",
      rows: [
        {
          type: "user",
          timestamp: at(1),
          message: {
            role: "user",
            content:
              '<teammate-message teammate_id="worker">{"type":"idle_notification"}</teammate-message>',
          },
        },
      ],
      want: { teammates: [{ name: "worker", spawned: false, state: "idle" }] },
    },
    {
      name: "the harness's own relay is not a member of the team",
      rows: [
        {
          type: "user",
          timestamp: at(1),
          message: {
            role: "user",
            content: '<teammate-message teammate_id="system">a notice</teammate-message>',
          },
        },
      ],
      want: { teammates: [] },
    },
    {
      name: "a stopped teammate stays on the list, stopped",
      rows: [
        call("t1", "Agent", { name: "worker" }),
        result("t1", { status: "teammate_spawned", name: "worker", agent_id: "tm-2" }, 1),
        call("t2", "TaskStop", { task_id: "worker" }, 2),
        result("t2", { task_type: "in_process_teammate", task_id: "worker" }, 3),
      ],
      want: { teammates: [{ name: "worker", state: "stopped" }] },
    },
    {
      name: "a task is created, then given a dependency",
      rows: [
        call("t1", "TaskCreate", { subject: "write the fold" }),
        result("t1", { task: { id: "1", subject: "write the fold" } }, 1),
        call("t2", "TaskUpdate", { taskId: "1", status: "in_progress", addBlockedBy: ["2"] }, 2),
        result("t2", { success: true }, 3),
      ],
      want: {
        todos: [
          {
            id: "1",
            subject: "write the fold",
            status: "in_progress",
            blocked_by: ["2"],
            blocks: [],
          },
        ],
      },
    },
    {
      name: "a deleted task leaves the list",
      rows: [
        call("t1", "TaskCreate", { subject: "gone" }),
        result("t1", { task: { id: "1", subject: "gone" } }, 1),
        call("t2", "TaskUpdate", { taskId: "1", status: "deleted" }, 2),
        result("t2", { success: true }, 3),
      ],
      want: { todos: [] },
    },
    {
      name: "the reminder restates the list, including what a subagent added",
      rows: [
        attachment({
          type: "task_reminder",
          itemCount: 1,
          content: [
            {
              id: "9",
              subject: "from a subagent",
              status: "pending",
              blockedBy: ["8"],
              owner: "me",
            },
          ],
        }),
      ],
      want: {
        todos: [
          {
            id: "9",
            subject: "from a subagent",
            status: "pending",
            owner: "me",
            blocked_by: ["8"],
            blocks: [],
          },
        ],
      },
    },
    {
      name: "an agent that ended is ended in both places it is held",
      rows: [
        call("t1", "Agent", { description: "survey" }),
        result("t1", { agentId: "a-1", isAsync: true }, 1),
        notification("a-1", "completed", 2),
      ],
      want: {
        background: [{ task_id: "a-1", status: "completed", ended_at: NOW + 2 }],
        agent_tree: {
          agents: [{ agent_id: "a-1", state: "completed", last_activity_at: NOW + 2 }],
        },
      },
    },
    {
      name: "a workflow's phases wait for the record it writes when it ends",
      rows: [
        call("t1", "Workflow", { description: "the release" }),
        result("t1", { taskId: "w-1", workflowName: "release", runId: "wf_abcdef01-abc" }, 1),
      ],
      want: {
        workflows: [
          {
            task_id: "w-1",
            name: "release",
            status: "running",
            started_at: NOW,
            run_id: "wf_abcdef01-abc",
            phases: [],
            agents: [],
          },
        ],
      },
    },
  ];

  for (const each of cases) {
    test(each.name, () => {
      const fold = new TranscriptFold();
      for (const row of each.rows) fold.line(JSON.stringify(row));
      expect(fold.facts).toMatchObject(each.want);
    });
  }

  test("a frame carrying every field the fold can fill still passes the contract", () => {
    const fold = new TranscriptFold();
    for (const each of cases) {
      for (const row of each.rows) fold.line(JSON.stringify(row));
    }
    const data = sessionStatusOf(SID, fold.facts, { root: "/tmp/ccmsg-fold-root" });
    // Every list the contract names actually carries something, so a schema
    // that only ever saw empty lists is not what passed.
    expect(data.todos.length).toBeGreaterThan(0);
    expect(data.teammates.length).toBeGreaterThan(0);
    expect(data.background.length).toBeGreaterThan(0);
    expect(data.workflows.length).toBeGreaterThan(0);
    expect(data.external_files.length).toBeGreaterThan(0);
    expect(data.agent_tree.agents.length).toBeGreaterThan(0);
    expect(data.agent_tree.teammates.length).toBeGreaterThan(0);
    expect(
      validationErrors(TOPIC_SCHEMAS["session_status"], {
        ev: "topic",
        topic: `session_status:${SID}`,
        snapshot: true,
        instance: SELF,
        data,
      }),
    ).toEqual([]);
  });

  test("a rewritten transcript takes everything folded out of the old one with it", () => {
    const fold = new TranscriptFold();
    fold.line(JSON.stringify(call("t1", "Read", { file_path: "/tmp/ccmsg-fold/x.txt" })));
    expect(fold.facts.named_files).toHaveLength(1);
    fold.reset();
    expect(fold.facts).toEqual(NO_FACTS);
  });
});

/** What a transcript of any size can still be asked (§3.3): the fold is seeded
 * from the end of the file, so a value that describes the present survives a
 * long session and a declaration made once, long ago, does not. */
describe("the tail window bounds what the fold can know", () => {
  const spawn = [
    {
      type: "assistant",
      timestamp: at(0),
      message: {
        model: "claude-fable-5",
        content: [
          { type: "tool_use", id: "t1", name: "Monitor", input: { description: "the build" } },
        ],
      },
    },
    {
      type: "user",
      timestamp: at(1),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
      toolUseResult: { taskId: "m-old" },
    },
  ];

  /** Enough rows to push the ones before them past the seed's window. */
  function filler(): object[] {
    const padding = "x".repeat(4096);
    const rows: object[] = [];
    while (rows.length * padding.length < FOLD_TAIL_BYTES + padding.length) {
      rows.push({ type: "system", subtype: "note", text: padding });
    }
    return rows;
  }

  test("a declaration older than the window is reported as nothing declared", async () => {
    const file = transcript([...spawn, ...filler()]);
    const { transcripts } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));
    // Indistinguishable from a session that started no task: the contract
    // spells "not in the window" and "nothing was declared" the same way.
    expect(transcripts.facts(SID).background).toEqual([]);

    // What happens after the fold is following is seen in full, however long
    // the file already was.
    file.append(...spawn.map((row) => ({ ...row, timestamp: at(2) })));
    await settled(() => transcripts.facts(SID).background.length > 0);
    expect(transcripts.facts(SID).background[0]?.task_id).toBe("m-old");
  });
});

describe("reading a slice by byte offset (§3.3)", () => {
  /** Records whose text is multibyte, so the byte a slice starts on lands
   * inside a character rather than before one. */
  const ROWS = [
    { type: "user", message: { role: "user", content: "日本語の一行目です" } },
    { type: "assistant", message: { role: "assistant", content: "二行目の返事です" } },
    { type: "user", message: { role: "user", content: "三行目、絵文字も 🎉 です" } },
  ];

  test("paging backwards through multibyte records reaches the beginning without overlap", () => {
    const file = transcript(ROWS);
    const whole = jsonl(ROWS);
    const size = Buffer.byteLength(whole);
    const lines = whole.split("\n").slice(0, -1);

    const tail = readSlice(SID, file.path, undefined, Buffer.byteLength(`${lines[2]}\n`));
    expect(tail.lines).toEqual([lines[2]]);
    expect(tail.end).toBe(size);
    // The record before it ends where this slice starts, in bytes.
    expect(tail.start).toBe(Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`));

    const earlier = readSlice(SID, file.path, tail.start);
    expect(earlier.lines).toEqual([lines[0], lines[1]]);
    expect(earlier.start).toBe(0);
    expect(earlier.end).toBe(tail.start);
  });

  test("a slice whose probe byte falls inside a character still starts where it says", () => {
    const file = transcript(ROWS);
    const whole = jsonl(ROWS);
    const lines = whole.split("\n").slice(0, -1);
    const firstTwo = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`);
    // Enough to reach into the middle record and no further, so the probe byte
    // is the one before the ask — which here is a continuation byte of a
    // multibyte character, not a boundary.
    const want = Buffer.byteLength(whole) - firstTwo + 8;

    const slice = readSlice(SID, file.path, undefined, want);

    expect(slice.lines).toEqual([lines[2]]);
    // The offsets are the ones the file actually has: reading from `start`
    // again yields the same records, which it cannot do if `start` was
    // computed from replacement characters of a different length.
    expect(slice.start).toBe(firstTwo);
    expect(readSlice(SID, file.path, undefined, Buffer.byteLength(whole) - firstTwo).lines).toEqual(
      [lines[2]],
    );
    expect(readSlice(SID, file.path, slice.start).lines).toEqual([lines[0], lines[1]]);
  });
});

describe("where a sid's transcript is (§5.1)", () => {
  /** A config home with one project directory under it. */
  function configHome() {
    const root = mkdtempSync(join(tmpdir(), "ccmsg-home-"));
    roots.push(root);
    mkdirSync(join(root, "projects", "a-project"), { recursive: true });
    return root;
  }

  test("what the session announced is what is read", () => {
    const root = configHome();
    const announced = join(root, "projects", "a-project", `${SID}.jsonl`);
    writeFileSync(announced, "");
    const files = new TranscriptFiles({
      harness: "claude",
      configHome: root,
      announced: () => announced,
    });
    expect(files.path(SID)).toBe(announced);
  });

  test("a sid nobody announced is found by the name the file carries", () => {
    const root = configHome();
    const written = join(root, "projects", "a-project", `${SID}.jsonl`);
    writeFileSync(written, "");
    const files = new TranscriptFiles({
      harness: "claude",
      configHome: root,
      announced: () => undefined,
    });
    expect(files.path(SID)).toBe(written);
  });

  test("a sid with no file under this config home has none", () => {
    const files = new TranscriptFiles({
      harness: "claude",
      configHome: configHome(),
      announced: () => undefined,
    });
    expect(files.path(SID)).toBeUndefined();
  });
});

describe("which standing a transcript was written from (§3.6)", () => {
  /** A session's transcript with one agent's file beside it, and whatever the
   * harness noted about that agent. */
  function written(note?: Record<string, unknown>): { files: TranscriptFiles; agent: string } {
    const root = mkdtempSync(join(tmpdir(), "ccmsg-subject-"));
    roots.push(root);
    const dir = join(root, "projects", "a-project");
    const under = join(dir, SID, "subagents");
    mkdirSync(under, { recursive: true });
    const session = join(dir, `${SID}.jsonl`);
    writeFileSync(session, "");
    const agent = join(under, "agent-acounter-9f.jsonl");
    writeFileSync(agent, "");
    if (note !== undefined) {
      writeFileSync(join(under, "agent-acounter-9f.meta.json"), JSON.stringify(note));
    }
    return {
      files: new TranscriptFiles({
        harness: "claude",
        configHome: root,
        announced: () => session,
      }),
      agent,
    };
  }

  test("a session's own transcript is read from the session", () => {
    const { files } = written();
    expect(files.subjectOf(files.session(SID))).toBe("main");
  });

  test("an agent the harness noted as a teammate is read as one", () => {
    const { files, agent } = written({ name: "counter", taskKind: "in_process_teammate" });
    expect(files.subjectOf(agent)).toBe("team");
  });

  test("an agent noted without that kind of task is an errand", () => {
    const { files, agent } = written({ name: "counter", agentType: "general-purpose" });
    expect(files.subjectOf(agent)).toBe("sub");
  });

  test("an agent the harness noted nothing readable about is an errand", () => {
    // The standing that claims the least: nothing goes on standing and nobody
    // is addressed by name, so a reader is not left writing back to something
    // that has already finished.
    const { files, agent } = written();
    expect(files.subjectOf(agent)).toBe("sub");
    writeFileSync(`${agent.slice(0, -".jsonl".length)}.meta.json`, "{ half a note");
    expect(files.subjectOf(agent)).toBe("sub");
  });
});

describe("the transcript_items topic (§3.6)", () => {
  const ITEMS_TOPIC = `transcript_items:${SID}`;

  /** One assistant record holding a turn's thinking, its words and a call —
   * three items out of one line, which is what makes an item's own id
   * necessary. */
  const turn = (uuid: string, offsetMs = 0) => ({
    type: "assistant",
    uuid,
    timestamp: at(offsetMs),
    message: {
      model: "claude-fable-5",
      content: [
        { type: "thinking", thinking: "wc will do" },
        { type: "text", text: "counting now" },
        { type: "tool_use", id: `t-${uuid}`, name: "Bash", input: { command: "wc -l < f" } },
      ],
    },
  });

  const spoke = (uuid: string, text: string, offsetMs = 0) => ({
    ...prompt(text, offsetMs),
    uuid,
    parentUuid: null,
  });

  function itemsOf(published: Published[]): Record<string, unknown>[] {
    return published
      .filter((frame) => frame.topic === ITEMS_TOPIC)
      .flatMap((frame) => frame.data["items"] as Record<string, unknown>[]);
  }

  test("what is appended arrives as the items those bytes were read as", async () => {
    const file = transcript([spoke("u1", "count the lines")]);
    const { transcripts, published } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));

    file.append(turn("a1", 1));
    await settled(() => itemsOf(published).length >= 3);
    const items = itemsOf(published);
    expect(items.map((item) => item["type"])).toEqual([
      "thinking",
      "message:user:out",
      "tool:Bash",
    ]);
    // One record, three items: the record's id is what they share and the
    // place in it is what tells them apart.
    expect(items.map((item) => item["id"])).toEqual(["a1:0", "a1:1", "a1:2"]);
    expect(items.every((item) => item["uuid"] === "a1")).toBe(true);
  });

  test("the record behind an item is what its source addresses", async () => {
    const file = transcript([spoke("u1", "count the lines")]);
    const { transcripts, published } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));

    file.append(turn("a1", 1));
    await settled(() => itemsOf(published).length >= 3);
    for (const item of itemsOf(published)) {
      const source = item["source"] as { offset: number; bytes: number };
      const read = readSlice(SID, file.path, source.offset + source.bytes, source.bytes);
      // The address is the record's, not the item's: several items out of one
      // record share it, and what comes back is the record whole.
      expect(read.lines).toHaveLength(1);
      expect(JSON.parse(read.lines[0] ?? "")).toMatchObject({ uuid: item["uuid"] });
    }
  });

  test("a result names the call it answers, whatever chunk the call arrived in", async () => {
    const file = transcript([spoke("u1", "count the lines")]);
    const { transcripts, published } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));

    file.append(turn("a1", 1));
    await settled(() => itemsOf(published).length >= 3);
    file.append({
      type: "user",
      uuid: "u2",
      timestamp: at(2),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-a1" }] },
      toolUseResult: { stdout: "3\n", interrupted: false },
    });
    await settled(() => itemsOf(published).length >= 4);
    const items = itemsOf(published);
    const answer = items[items.length - 1];
    // The call was handed over in an earlier frame and is not sent again: a
    // subscriber appends, and ties the two together by the id the result
    // carries.
    expect(answer?.["parent_item"]).toBe("a1:2");
    expect(items.filter((item) => item["id"] === "a1:2")).toHaveLength(1);
  });

  test("a subscription opens on the end of what has been read", async () => {
    const file = transcript([spoke("u1", "count the lines"), turn("a1", 1)]);
    const { transcripts } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));
    const opened = () =>
      transcripts.snapshot(ITEMS_TOPIC)[0]?.data as
        | { items: Record<string, unknown>[] }
        | undefined;
    await settled(() => (opened()?.items.length ?? 0) > 0);
    expect(opened()?.items.map((item) => item["type"])).toEqual([
      "message:user:in",
      "thinking",
      "message:user:out",
      "tool:Bash",
    ]);
  });

  test("a subscription in the turn the tail starts opens on the end, not on nothing", () => {
    // The items a subscriber opens on are read in the same turn the tail is
    // started, for the reason the raw topic's size is: an empty snapshot would
    // send a client that draws the newest items looking for them at the
    // beginning of the transcript instead.
    const rows = Array.from({ length: ITEMS_SNAPSHOT + 40 }, (_, at) =>
      spoke(`u${String(at)}`, "hi", at),
    );
    const file = transcript(rows);
    const { transcripts } = domain(file.path);
    transcripts.hold(SID);
    const opened = transcripts.snapshot(ITEMS_TOPIC)[0]?.data as {
      items: Record<string, unknown>[];
    };
    // One item per record here, so the tail of the file is the tail of the
    // snapshot, cut to the count it is bounded by.
    expect(opened.items).toHaveLength(ITEMS_SNAPSHOT);
    expect(opened.items.at(-1)?.["uuid"]).toBe(`u${String(rows.length - 1)}`);
  });

  test("the frames pass the contract", async () => {
    const file = transcript([spoke("u1", "count the lines")]);
    const { transcripts, published } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));
    const snapshot = transcripts.snapshot(ITEMS_TOPIC)[0]?.data;
    file.append(turn("a1", 1));
    await settled(() => itemsOf(published).length >= 3);

    const schema = TOPIC_SCHEMAS.transcript_items;
    const frame = published.find((one) => one.topic === ITEMS_TOPIC)?.data;
    for (const data of [snapshot, frame]) {
      expect(
        validationErrors(schema, { ev: "topic", topic: ITEMS_TOPIC, instance: SELF, data }),
      ).toEqual([]);
    }
  });

  test("a file replaced under the tail is read as items from its beginning", async () => {
    const file = transcript([spoke("u1", "count the lines"), turn("a1", 1)]);
    const { transcripts, published } = domain(file.path);
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));

    writeFileSync(file.path, jsonl([spoke("u9", "a fresh start", 2)]));
    await settled(() => itemsOf(published).length > 0);
    expect(itemsOf(published).map((item) => item["id"])).toEqual(["u9:0"]);
    const opened = transcripts.snapshot(ITEMS_TOPIC)[0]?.data as {
      items: Record<string, unknown>[];
    };
    expect(opened.items.map((item) => item["uuid"])).toEqual(["u9"]);
  });
});
