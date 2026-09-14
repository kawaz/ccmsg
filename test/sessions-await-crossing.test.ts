import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HelloResult,
  OP_NAMES,
  PROTOCOL_VERSION,
  type SessionApiError,
  type Sid,
} from "@ccmsg/protocol";
import { dispatch, type Handlers, OpError } from "../src/dispatch/index.ts";
import {
  type MeshSource,
  Sessions,
  SessionStatus,
  sessionStatusOf,
} from "../src/sessions/index.ts";
import { NO_FACTS, TranscriptFold } from "../src/transcript/index.ts";
import { BaseConn, createDriver } from "../src/transport/index.ts";
import { greeting, OTHER_SID, SELF, SELF_ENDPOINT, SID } from "./frames.ts";
import { trackRoot } from "./harness.ts";

/** What the sessions domain has to hold to on the far side of an await
 * (DR-0015 §2.5): that a connection greets once even when its greetings arrive
 * together, that what the fold hands out is the instant it was asked for, and
 * that the list of stopped sessions covers a session that arrived while the
 * others were being read. */

const NOW = Date.parse("2026-09-14T10:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const roots: string[] = [];
const running: Sessions[] = [];

afterEach(() => {
  for (const domain of running.splice(0)) {
    domain.stop("peers");
    domain.stop("agents");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway config home with one transcript in its tree, so that a greeting
 * naming it has a path to settle — which is the read the greeting waits on. */
function home() {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-sessions-await-"));
  roots.push(root);
  trackRoot(root);
  mkdirSync(join(root, "sessions"), { recursive: true });
  mkdirSync(join(root, "projects", "a"), { recursive: true });
  const transcript = join(root, "projects", "a", "b.jsonl");
  writeFileSync(transcript, "");
  return { root, transcript: realpathSync(transcript) };
}

function sessions(overrides: { mesh?: MeshSource } = {}) {
  const { root, transcript } = home();
  const domain = new Sessions({
    harness: "claude",
    self: SELF,
    endpoint: SELF_ENDPOINT,
    configHome: root,
    stateDir: join(root, "state"),
    capabilities: [],
    version: "0.0.1",
    startedAt: NOW,
    publish: () => {},
    pollMs: 50,
    ...(overrides.mesh === undefined ? {} : { mesh: overrides.mesh }),
  });
  running.push(domain);
  return { domain, transcript };
}

/** One connection driven the way transport drives it: a line in, a frame
 * dispatched, the identity settled by the reply. Every op but the greetings
 * answers nothing, since nothing here is about them. */
function driven(domain: Sessions) {
  const sent: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  const conn = new BaseConn(1, {
    send: (line) => {
      sent.push(JSON.parse(line));
      for (const waiter of waiters.splice(0)) waiter();
    },
    close: () => {},
  });
  const handlers = Object.fromEntries(OP_NAMES.map((op) => [op, () => ({})])) as Record<
    string,
    unknown
  >;
  handlers["hello.session"] = domain.helloSession;
  handlers["hello.user"] = domain.helloUser;
  handlers["hello.instance"] = domain.helloInstance;
  const driver = createDriver(conn, (frame, requester) =>
    dispatch(frame, requester, {
      self: SELF,
      capabilities: new Set(),
      resolveInstance: () => undefined,
      handlers: handlers as unknown as Handlers,
    }),
  );
  return {
    conn,
    sent,
    /** Several lines arriving in one chunk: handed to the driver one after the
     * other with nothing in between, as `LineReader` hands them. */
    chunk: (...frames: object[]) => {
      for (const frame of frames) driver.line(JSON.stringify(frame));
    },
    /** The reply to one request, once it has gone out: waited for on the
     * next line sent rather than looked for on a clock. */
    replied: async (requestId: string) => {
      const reply = () => sent.find((frame) => frame["request_id"] === requestId);
      while (reply() === undefined) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      return reply() as Record<string, unknown>;
    },
  };
}

function helloSession(requestId: string, transcript: string, sid: Sid = SID) {
  return {
    op: "hello.session",
    request_id: requestId,
    protocol_version: PROTOCOL_VERSION,
    sid,
    transcript_path: transcript,
  };
}

function helloUser(requestId: string) {
  return { op: "hello.user", request_id: requestId, protocol_version: PROTOCOL_VERSION };
}

describe("a connection greets once, whenever its greetings arrive (DR-0015 §2.5)", () => {
  test("two greetings in one chunk: the second is refused and one identity stands", async () => {
    // The first greeting waits on a read of the filesystem before it can be
    // answered, and the second arrives while it waits. Nothing has settled the
    // connection yet, so what refuses the second is the claim the first took
    // when it was judged — not the identity, which the reply settles later.
    const { domain, transcript } = sessions();
    const { conn, chunk, replied } = driven(domain);
    chunk(helloSession("1", transcript), helloUser("2"));

    const second = await replied("2");
    expect(second["ok"]).toBe(false);
    expect((second["error"] as Record<string, unknown>)["code"]).toBe("bad_request");
    const first = await replied("1");
    expect(first["ok"]).toBe(true);

    expect(conn.identity).toEqual({ state: "settled", role: "session", sid: SID });
    expect(domain.connectedSids()).toEqual([SID]);
  });

  test("two session greetings in one chunk: one session is registered, not two", async () => {
    const { domain, transcript } = sessions();
    const { conn, chunk, replied } = driven(domain);
    chunk(helloSession("1", transcript), helloSession("2", transcript, OTHER_SID));

    expect((await replied("2"))["ok"]).toBe(false);
    expect((await replied("1"))["ok"]).toBe(true);
    expect(conn.identity).toEqual({ state: "settled", role: "session", sid: SID });
    expect(domain.connectedSids()).toEqual([SID]);
  });

  test("a greeting that could not be answered leaves the connection free to greet", async () => {
    // The claim is taken before the wait and given back when the greeting
    // fails, so a refused greeting does not leave the connection unable to
    // greet at all.
    const mesh: MeshSource = {
      greet: () => Promise.reject(new OpError("forbidden", "not a peer")),
      instances: () => [],
    };
    const { domain } = sessions({ mesh });
    const conn = greeting();
    const claim = {
      op: "hello.instance",
      request_id: "1",
      protocol_version: PROTOCOL_VERSION,
      mesh: { ver: 1, iss: SELF, aud: SELF, id: SELF, kid: "0123456789abcdef" },
    };
    const refused = await domain
      .helloInstance({
        op: "hello.instance",
        conn,
        args: claim,
      } as unknown as Parameters<typeof domain.helloInstance>[0])
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(refused).toBeInstanceOf(OpError);

    const answered = domain.helloUser({
      op: "hello.user",
      conn,
      args: helloUser("2"),
    }) as HelloResult;
    expect(answered.instance).toBe(SELF);
  });
});

/** A fold with one turn stopped on an error and one background task running:
 * the two values a torn payload would show from different instants. */
function foldWithRunningTask() {
  const fold = new TranscriptFold();
  const line = (row: object) => fold.line(JSON.stringify(row));
  line({
    type: "assistant",
    timestamp: at(0),
    message: {
      model: "claude-fable-5",
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "Bash",
          input: { description: "watch the build", run_in_background: true },
        },
      ],
    },
  });
  line({
    type: "user",
    timestamp: at(1),
    toolUseResult: { backgroundTaskId: "task-1" },
    message: { content: [{ type: "tool_result", tool_use_id: "call-1" }] },
  });
  line({
    type: "assistant",
    isApiErrorMessage: true,
    timestamp: at(2),
    message: { model: "<synthetic>", content: [{ type: "text", text: "Prompt is too long" }] },
  });
  return {
    fold,
    /** The task ends and the model answers again, which clears both values. */
    advance: () => {
      line({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: at(3),
        content:
          "<task-notification><task-id>task-1</task-id><status>completed</status></task-notification>",
      });
      line({
        type: "assistant",
        timestamp: at(4),
        message: { model: "claude-fable-5", content: [{ type: "text", text: "done" }] },
      });
    },
  };
}

describe("what the fold hands out is the instant it was asked for (DR-0015 §2.5)", () => {
  test("writing through the facts changes nothing the fold holds", () => {
    const { fold } = foldWithRunningTask();
    const before = JSON.stringify(fold.facts);
    const taken = fold.facts as unknown as {
      background: { status: string }[];
      todos: unknown[];
      agent_tree: { agents: unknown[] };
      api_error?: { text: string };
    };
    taken.background[0]!.status = "written through";
    taken.background.push({ status: "added" });
    taken.todos.push({});
    taken.agent_tree.agents.push({});
    if (taken.api_error !== undefined) taken.api_error.text = "written through";
    expect(JSON.stringify(fold.facts)).toBe(before);
  });

  test("a payload built across a read states one instant of the fold", async () => {
    // `sessionStatusOf` reads the error before its filesystem reads and the
    // task list after them. The fold moves during the reads, and what the
    // payload says of the task must be what the fold said when the error was
    // read — not what the fold has come to say since.
    const { fold, advance } = foldWithRunningTask();
    const root = mkdtempSync(join(tmpdir(), "ccmsg-status-root-"));
    roots.push(root);
    trackRoot(root);
    const building = sessionStatusOf(SID, fold.facts, { root, cwd: root });
    advance();
    expect(fold.facts.api_error).toBeUndefined();
    expect(fold.facts.background[0]?.status).toBe("completed");

    const payload = await building;
    expect(payload.api_error).toEqual({ text: "Prompt is too long", occurred_at: NOW + 2 });
    expect(payload.background.map((task) => task.status)).toEqual(["running"]);
  });
});

describe("the list of stopped sessions covers a session that arrived mid-read", () => {
  test("session.errors waits on a session added while the others were read", async () => {
    // The first wait covers the sessions there were when it began. One that
    // greeted during it is on the list by the time the list is read, and its
    // fold has to be waited on too, or it is described from a fold still
    // reading.
    const stopped: SessionApiError = { text: "Prompt is too long", occurred_at: NOW + 1 };
    const live: Sid[] = [SID];
    let otherRead = false;
    const status = new SessionStatus({
      self: SELF,
      sessions: () => [...live],
      facts: (sid) =>
        sid === OTHER_SID && otherRead ? { ...NO_FACTS, api_error: stopped } : NO_FACTS,
      where: () => ({}),
      hold: () => {},
      release: () => {},
      ready: async (sid) => {
        if (sid === SID) {
          // Arrives during the wait on the first session.
          if (!live.includes(OTHER_SID)) live.push(OTHER_SID);
          return;
        }
        await Promise.resolve();
        otherRead = true;
      },
      publish: () => {},
    });

    const [value] = await status.snapshot("session.errors");
    const listed = value?.data as { errors: { sid: Sid }[] } | undefined;
    expect(listed?.errors.map((entry) => entry.sid)).toEqual([OTHER_SID]);
  });
});
