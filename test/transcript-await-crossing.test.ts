import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOLD_CACHE_VERSION,
  FoldCache,
  READ_CHUNK_BYTES,
  Transcripts,
} from "../src/transcript/index.ts";
import { TranscriptTail } from "../src/transcript/tail.ts";
import { SELF, SID } from "./frames.ts";
import { trackRoot } from "./harness.ts";

const TOPIC = `transcript:${SID}`;
/** Fast enough that a test can wait for the backstop rather than the watch. */
const POLL_MS = 5;

const roots: string[] = [];
const running: Transcripts[] = [];
const tails: TranscriptTail[] = [];
afterEach(() => {
  for (const tail of tails.splice(0)) tail.stop();
  for (const domain of running.splice(0)) domain.stopAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway directory under the OS temp dir, for a transcript or a cache. */
function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  trackRoot(root);
  roots.push(root);
  return root;
}

function transcript(lines: readonly object[] = []) {
  const path = join(scratch("ccmsg-await-transcript-"), `${SID}.jsonl`);
  writeFileSync(path, jsonl(lines));
  return {
    path,
    append(...rows: object[]) {
      appendFileSync(path, jsonl(rows));
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

interface Domain {
  transcripts: Transcripts;
  published: Published[];
  facts: string[];
}

function domain(
  pathOf: () => Promise<string | undefined>,
  cache?: FoldCache,
  onPublish: (domain: Domain, frame: Published) => void = () => {},
): Domain {
  const made: Domain = {
    transcripts: undefined as unknown as Transcripts,
    published: [],
    facts: [],
  };
  made.transcripts = new Transcripts({
    self: SELF,
    pathOf,
    ...(cache === undefined ? {} : { cache }),
    publish: (topic, data) => {
      const frame = { topic, data: data as Record<string, unknown> };
      made.published.push(frame);
      onPublish(made, frame);
    },
    onFacts: (sid) => made.facts.push(sid),
    pollMs: POLL_MS,
  });
  running.push(made.transcripts);
  return made;
}

/** Wait for the tail's confirmation poll to have read what was just written. */
async function settled(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await Bun.sleep(POLL_MS);
  }
  expect(check()).toBe(true);
}

const NOW = Date.parse("2026-09-08T10:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const prompt = (text: string, offsetMs = 0) => ({
  type: "user",
  timestamp: at(offsetMs),
  message: { role: "user", content: text },
});

const call = (id: string, name: string, input: object, offsetMs = 0) => ({
  type: "assistant",
  timestamp: at(offsetMs),
  message: { model: "claude-fable-5", content: [{ type: "tool_use", id, name, input }] },
});

const result = (id: string, toolUseResult: object, offsetMs = 0) => ({
  type: "user",
  timestamp: at(offsetMs),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id }] },
  toolUseResult,
});

/** Where `FoldCache` keeps one transcript, named the way it names it. */
async function entryFile(dir: string, path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return join(dir, `${createHash("sha256").update(path).digest("hex").slice(0, 32)}.json`);
}

/** An entry of the current version claiming something the file does not say,
 * so that reading it back is the only way the claim can appear. */
function planted(path: string, fold: object = {}, items: unknown[] = []): Record<string, unknown> {
  const known = statSync(path);
  return {
    version: FOLD_CACHE_VERSION,
    path,
    dev: known.dev,
    ino: known.ino,
    offset: known.size,
    reading: { turn: 0, subject: "main", calls: [] },
    fold: {
      last_user_input_at: 4242,
      files: [],
      todos: [],
      teammates: [],
      background: [],
      workflows: [],
      agents: [],
      calls: [],
      ...fold,
    },
    items,
  };
}

describe("what a cache brings back is an input, not a promise kept (DR-0015 §2.5)", () => {
  /** Each is an entry of the right version and the right top-level shape whose
   * contents a later record walks into: read back unchecked, the walk throws
   * from inside the tail and takes the instance down with it, or throws from
   * the opening and leaves the session unopenable until the file is deleted
   * by hand. Read back checked, each says nothing and the file is read. */
  const broken: { name: string; fold?: object; items?: unknown[]; walked: object[] }[] = [
    {
      name: "a pending call without its arguments",
      fold: { calls: [["t1", { name: "Bash" }]] },
      walked: [result("t1", { stdout: "x\n" }, 1)],
    },
    {
      name: "a teammate that is not an object",
      fold: { teammates: [["ann", null]] },
      walked: [prompt("again", 1)],
    },
    {
      name: "a todo whose dependency list is not a list",
      fold: { todos: [["1", { subject: "x", status: "pending", blocked_by: 5, blocks: [] }]] },
      walked: [
        call("t2", "TaskUpdate", { taskId: "1", status: "in_progress", addBlockedBy: ["2"] }, 1),
        result("t2", { success: true }, 2),
      ],
    },
    {
      name: "an item that is not an object",
      items: [null],
      walked: [prompt("again", 1)],
    },
  ];

  for (const { name, fold, items, walked } of broken) {
    test(`${name} is read past, and the file is read and followed`, async () => {
      const file = transcript([prompt("the first thing typed")]);
      const dir = scratch("ccmsg-await-cache-");
      const cache = new FoldCache(dir);
      writeFileSync(
        await entryFile(dir, file.path),
        JSON.stringify(planted(file.path, fold, items)),
      );

      const { transcripts, published } = domain(async () => file.path, cache);
      transcripts.hold(SID);
      await transcripts.ready(SID);
      // The file's own answer, not the planted one: the entry said nothing.
      expect(transcripts.facts(SID).last_user_input_at).toBe(NOW);
      expect(transcripts.following(SID)).toBe(true);

      // The record that walks into what the entry held. The tail goes on
      // reading, so it is published rather than thrown out of the reading.
      file.append(...walked);
      await settled(() => published.some((frame) => frame.topic === TOPIC));
      expect(transcripts.following(SID)).toBe(true);
    });
  }

  test("an entry the opening cannot take up is dropped, so the next look reads the file", async () => {
    // A cache whose entry passes the shape check and fails on being taken up
    // stands for whatever a later build's reading walks into that the check
    // does not yet name. Such an entry fails the same way each time it is read,
    // so the failure has to take the entry with it: until it is dropped, this
    // cache keeps handing it back.
    const file = transcript([prompt("the first thing typed")]);
    const dir = scratch("ccmsg-await-cache-");
    const dropped: string[] = [];
    class Stuck extends FoldCache {
      override async read(path: string) {
        if (dropped.includes(path)) return super.read(path);
        const entry = planted(path);
        const fold = entry["fold"] as Record<string, unknown>;
        Object.defineProperty(fold, "files", {
          get() {
            throw new TypeError("not what this build restores");
          },
        });
        return entry as unknown as Awaited<ReturnType<FoldCache["read"]>>;
      }
      override drop(path: string) {
        dropped.push(path);
        return super.drop(path);
      }
    }

    const { transcripts } = domain(async () => file.path, new Stuck(dir));
    transcripts.hold(SID);
    await transcripts.ready(SID);
    expect(dropped).toEqual([file.path]);

    // A second hold joins the same session, which is read on the next look
    // now that the entry is gone.
    transcripts.hold(SID);
    await settled(() => transcripts.following(SID));
    await transcripts.ready(SID);
    expect(transcripts.facts(SID).last_user_input_at).toBe(NOW);

    // Both holds count against the one entry: the first release leaves the
    // tail running and the second stops it.
    transcripts.release(SID);
    expect(transcripts.following(SID)).toBe(true);
    transcripts.release(SID);
    expect(transcripts.following(SID)).toBe(false);
  });

  test("what is kept describes the moment it was kept, not the moment it was written", async () => {
    // The state handed over is the fold's and the reading's own objects, which
    // go on being written into while the write waits its turn. What lands on
    // disk has to be what they said when `save` was called.
    const file = transcript([prompt("the first thing typed")]);
    const dir = scratch("ccmsg-await-cache-");
    const cache = new FoldCache(dir);
    const todo = { id: "1", subject: "before", status: "pending", blocked_by: [], blocks: [] };
    const item = { id: "u1:0", uuid: "u1", type: "user", at: NOW, turn: 1, subject: "main" };
    const fold = {
      files: [],
      todos: [["1", todo]] as const,
      teammates: [],
      background: [],
      workflows: [],
      agents: [],
      calls: [],
    };
    const saving = cache.save(
      file.path,
      statSync(file.path).size,
      fold,
      { turn: 1, subject: "main", calls: [] },
      [item as never],
    );
    todo.subject = "after";
    (item as Record<string, unknown>)["text"] = "after";
    await saving;

    const kept = await cache.read(file.path);
    expect(kept?.fold.todos[0]?.[1]?.subject).toBe("before");
    const first = kept?.items[0] as Record<string, unknown> | undefined;
    expect(first?.["id"]).toBe("u1:0");
    expect(first?.["text"]).toBeUndefined();
  });
});

describe("a hold on a session whose file is not there yet (DR-0015 §2.5)", () => {
  test("the entry stays with its holds, and the file is picked up when it appears", async () => {
    // A plugin greets before the harness writes the first record, so the
    // status domain holds the session while nothing can be found for it. That
    // hold is a promise to release, and the entry it counts against has to be
    // the one still there when the file appears and somebody else holds it —
    // otherwise the first release stops a tail the second holder is reading.
    const root = scratch("ccmsg-await-transcript-");
    const path = join(root, `${SID}.jsonl`);
    const { transcripts, published, facts } = domain(async () =>
      existsSync(path) ? path : undefined,
    );

    transcripts.hold(SID);
    await transcripts.ready(SID);
    expect(await transcripts.snapshot(TOPIC)).toEqual([]);
    expect(transcripts.following(SID)).toBe(false);

    writeFileSync(path, jsonl([prompt("the first thing typed")]));
    await settled(() => transcripts.following(SID));
    await transcripts.ready(SID);
    // The subscriber opened on nothing, so what the file holds is what was
    // appended after it — the first frame, from the beginning of the file —
    // and what the fold settled out of it is news to the domain.
    expect(published.map((frame) => [frame.topic, frame.data["start"]])).toContainEqual([TOPIC, 0]);
    expect(transcripts.facts(SID).last_user_input_at).toBe(NOW);
    expect(facts).toContain(SID);

    transcripts.hold(SID);
    transcripts.release(SID);
    expect(transcripts.following(SID)).toBe(true);
    transcripts.release(SID);
    expect(transcripts.following(SID)).toBe(false);
  });

  test("the last release while the file is still absent ends the looking", async () => {
    const root = scratch("ccmsg-await-transcript-");
    const path = join(root, `${SID}.jsonl`);
    let looked = 0;
    const { transcripts } = domain(async () => {
      looked += 1;
      return existsSync(path) ? path : undefined;
    });

    transcripts.hold(SID);
    await transcripts.ready(SID);
    transcripts.release(SID);
    const before = looked;
    writeFileSync(path, jsonl([prompt("the first thing typed")]));
    await Bun.sleep(POLL_MS * 6);
    expect(looked).toBe(before);
    expect(transcripts.following(SID)).toBe(false);
  });
});

describe("a stopped tail stops itself at its next await (DR-0015 §2.5)", () => {
  /** Rows the fold settles something new from, enough of them that a read of
   * them all is several reads with the loop handed back between. */
  function bulk(from: number, reads: number): object[] {
    const padding = "x".repeat(4096);
    const rows: object[] = [];
    while (rows.length * padding.length < READ_CHUNK_BYTES * reads) {
      rows.push(prompt(`${padding} ${String(rows.length)}`, from + rows.length + 1));
    }
    return rows;
  }

  test("released from inside the first frame, the reading publishes no second one", async () => {
    const file = transcript([prompt("the first thing typed")]);
    let stated = 0;
    const { transcripts, published, facts } = domain(
      async () => file.path,
      undefined,
      (own, frame) => {
        if (frame.topic !== TOPIC) return;
        stated += 1;
        // The picture switched away from as the first frame lands: nothing after
        // it is wanted, however much of the file is still unread.
        if (stated === 1) own.transcripts.release(SID);
      },
    );
    transcripts.hold(SID);
    await transcripts.ready(SID);

    file.append(...bulk(0, 3));
    await settled(() => stated >= 1);
    const told = facts.length;
    await Bun.sleep(POLL_MS * 20);
    expect(published.filter((frame) => frame.topic === TOPIC)).toHaveLength(1);
    expect(facts).toHaveLength(told);
    expect(transcripts.following(SID)).toBe(false);
  });

  test("a read queued before the stop neither states nor moves the offset", async () => {
    const file = transcript([prompt("the first thing typed")]);
    const frames: number[] = [];
    let truncated = 0;
    const tail = new TranscriptTail(file.path, {
      onExisting: () => {},
      onAppended: (appended) => {
        frames.push(appended.start);
        if (frames.length !== 1) return;
        // Stopped by whoever got the first frame, while the rest is unread,
        // and the file replaced under the stopped tail before the read queued
        // behind this one gets its turn: the reading that would have called
        // that a truncation is nobody's, and what it would have thrown away —
        // the entry another reading has since kept — is not thrown away.
        tail.stop();
        writeFileSync(file.path, jsonl([prompt("a fresh start", 1)]));
      },
      onTruncated: () => {
        truncated += 1;
      },
      pollMs: POLL_MS,
    });
    tails.push(tail);
    await tail.start();
    const before = tail.offset;
    file.append(...bulk(0, 3));
    const reading = tail.refresh();
    // What a watch event and the poll had already queued behind that read.
    const queued = tail.refresh();
    await reading;
    const stopped = tail.offset;
    await queued;
    expect(frames).toHaveLength(1);
    expect(stopped).toBeGreaterThan(before);
    expect(stopped).toBeLessThan(before + READ_CHUNK_BYTES * 2);
    expect(truncated).toBe(0);
    expect(tail.offset).toBe(stopped);
  });
});
