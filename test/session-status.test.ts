import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Sid, TOPIC_SCHEMAS, validationErrors } from "@ccmsg/protocol";
import { SessionStatus } from "../src/sessions/index.ts";
import { Topics } from "../src/topics/index.ts";
import { Transcripts } from "../src/transcript/index.ts";
import { connAs, OTHER_SID, SELF, SID } from "./frames.ts";

const STATUS = `session_status:${SID}`;
const ERRORS = "session_errors";
const POLL_MS = 5;

const roots: string[] = [];
const running: Transcripts[] = [];
afterEach(() => {
  for (const domain of running.splice(0)) domain.stopAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-08T10:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** A row the harness wrote about a turn that stopped, and one the model
 * produced, which is what clears it. Spelled as the fold's own tests spell
 * them, since what the fold reads is settled there. */
const apiError = (text: string, offsetMs = 0) => ({
  type: "assistant",
  isApiErrorMessage: true,
  timestamp: at(offsetMs),
  message: { model: "<synthetic>", content: [{ type: "text", text }] },
});
const answer = (offsetMs = 0) => ({
  type: "assistant",
  timestamp: at(offsetMs),
  message: { model: "claude-fable-5", content: [{ type: "text", text: "here you go" }] },
});

function jsonl(rows: readonly object[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

/** The transcript files of a set of sessions, under the OS temp dir. */
function transcripts(sids: readonly Sid[]) {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-session-status-"));
  roots.push(root);
  const paths = new Map<Sid, string>();
  for (const sid of sids) {
    const path = join(root, `${sid}.jsonl`);
    writeFileSync(path, "");
    paths.set(sid, path);
  }
  return {
    pathOf: (sid: Sid) => paths.get(sid),
    append(sid: Sid, ...rows: object[]) {
      appendFileSync(paths.get(sid) ?? "", jsonl(rows));
    },
  };
}

interface Published {
  topic: string;
  data: Record<string, unknown>;
}

/** The two topics wired to the tails behind them, as the instance wires them:
 * the fold changing tells the owner, and the owner states both topics. */
function domain(sids: Sid[]) {
  const files = transcripts(sids);
  const published: Published[] = [];
  const live = [...sids];
  const folds = new Transcripts({
    self: SELF,
    pathOf: files.pathOf,
    publish: () => {},
    onFacts: () => status.refresh(),
    pollMs: POLL_MS,
  });
  running.push(folds);
  const status = new SessionStatus({
    self: SELF,
    sessions: () => live,
    facts: (sid) => folds.facts(sid),
    where: () => ({}),
    hold: (sid) => folds.hold(sid),
    release: (sid) => folds.release(sid),
    publish: (topic, data) => published.push({ topic, data: data as Record<string, unknown> }),
  });
  const hub = new Topics(SELF, new Set());
  hub.attach("session_status", status);
  hub.attach("session_errors", status);
  return {
    files,
    published,
    folds,
    status,
    hub,
    /** The sessions the instance holds, as `hello` and a closing connection
     * move them. Changing the set is what the owner is told about. */
    setSessions: (next: Sid[]) => {
      live.splice(0, live.length, ...next);
      status.refresh();
    },
  };
}

async function settled(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await Bun.sleep(POLL_MS);
  }
  expect(check()).toBe(true);
}

describe("the topics the fold's error state feeds (§3.3)", () => {
  test("an error appended reaches both of them", async () => {
    const { files, published, hub, status } = domain([SID]);
    expect(hub.subscribe(connAs("user"), ERRORS)).toBe("ok");
    expect(hub.subscribe(connAs("user"), STATUS)).toBe("ok");
    await settled(() => status.holding(SID));

    files.append(SID, apiError("Prompt is too long", 1));
    await settled(() => status.errors().errors.length > 0);

    const errors = published.filter((frame) => frame.topic === ERRORS).at(-1);
    expect(errors?.data["errors"]).toEqual([
      { sid: SID, instance: SELF, text: "Prompt is too long", occurred_at: NOW + 1 },
    ]);
    const state = published.filter((frame) => frame.topic === STATUS).at(-1);
    expect(state?.data["sid"]).toBe(SID);
    expect(state?.data["api_error"]).toEqual({
      text: "Prompt is too long",
      occurred_at: NOW + 1,
    });
  });

  test("a session that recovers drops out of the list", async () => {
    const { files, published, hub, status } = domain([SID]);
    hub.subscribe(connAs("user"), ERRORS);
    await settled(() => status.holding(SID));
    files.append(SID, apiError("API Error: 500", 1));
    await settled(() => (status.errors().errors.length ?? 0) > 0);

    files.append(SID, answer(2));
    await settled(() => status.errors().errors.length === 0);
    expect(published.filter((frame) => frame.topic === ERRORS).at(-1)?.data["errors"]).toEqual([]);
  });

  test("the frames pass the contract", async () => {
    const { files, hub, status } = domain([SID]);
    hub.subscribe(connAs("user"), ERRORS);
    hub.subscribe(connAs("user"), STATUS);
    await settled(() => status.holding(SID));
    files.append(SID, apiError("Please run /login", 1));
    await settled(() => status.errors().errors.length > 0);

    for (const topic of [STATUS, ERRORS]) {
      const kind = topic === ERRORS ? "session_errors" : "session_status";
      const data = status.snapshot(topic)[0]?.data;
      expect(
        validationErrors(TOPIC_SCHEMAS[kind], {
          ev: "topic",
          topic,
          snapshot: true,
          instance: SELF,
          data,
        }),
      ).toEqual([]);
    }
  });
});

describe("the tails run while somebody is listening (§6.3)", () => {
  test("subscribing to the list holds every session, and the last unsubscribe releases them", async () => {
    const { hub, folds, status } = domain([SID, OTHER_SID]);
    const watcher = connAs("user");
    const second = connAs("user");
    expect(folds.following(SID)).toBe(false);

    expect(hub.subscribe(watcher, ERRORS)).toBe("ok");
    await settled(() => folds.following(SID) && folds.following(OTHER_SID));

    hub.subscribe(second, ERRORS);
    hub.unsubscribe(watcher, ERRORS);
    expect(folds.following(SID)).toBe(true);

    hub.unsubscribe(second, ERRORS);
    expect(status.holding(SID)).toBe(false);
    expect(folds.following(SID)).toBe(false);
    expect(folds.following(OTHER_SID)).toBe(false);
  });

  test("one session's status holds that session and no other", async () => {
    const { hub, folds } = domain([SID, OTHER_SID]);
    hub.subscribe(connAs("user"), STATUS);
    await settled(() => folds.following(SID));
    expect(folds.following(OTHER_SID)).toBe(false);
  });

  test("the held tails follow the sessions the instance holds", async () => {
    const { hub, folds, setSessions, status } = domain([SID, OTHER_SID]);
    hub.subscribe(connAs("user"), ERRORS);
    setSessions([SID]);
    await settled(() => folds.following(SID));
    expect(status.holding(OTHER_SID)).toBe(false);
    expect(folds.following(OTHER_SID)).toBe(false);

    setSessions([SID, OTHER_SID]);
    await settled(() => folds.following(OTHER_SID));
    expect(status.holding(OTHER_SID)).toBe(true);
  });

  test("a tail a subscription shares is released once", async () => {
    const { hub, folds } = domain([SID]);
    const list = connAs("user");
    const one = connAs("user");
    hub.subscribe(list, ERRORS);
    hub.subscribe(one, STATUS);
    await settled(() => folds.following(SID));

    hub.unsubscribe(list, ERRORS);
    // The other topic still wants it, so the release of the first want is not
    // the release of the tail.
    expect(folds.following(SID)).toBe(true);
    hub.unsubscribe(one, STATUS);
    expect(folds.following(SID)).toBe(false);
  });
});
