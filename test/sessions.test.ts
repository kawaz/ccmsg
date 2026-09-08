import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HelloResult,
  LAST_LIVE_RETENTION_MS,
  OP_SCHEMAS,
  PROTOCOL_VERSION,
  type SessionState,
  type Sid,
  TOPIC_SCHEMAS,
  validationErrors,
} from "@ccmsg/protocol";
import { Topics } from "../src/topics/index.ts";
import {
  classify,
  type GatewaySource,
  LastLiveStore,
  type SessionInputs,
  Sessions,
} from "../src/sessions/index.ts";
import { connAs, SELF, SID, OTHER_SID, TestConn } from "./frames.ts";

/** A throwaway config home under the OS temp dir, which is where the harness's
 * `sessions/` and this instance's state directory both hang. */
function home() {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-sessions-"));
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  homes.push(root);
  return { root, sessionsDir, stateDir: join(root, "state") };
}

const homes: string[] = [];
const running: Sessions[] = [];
afterEach(() => {
  // A watch left running is a real file watch and a real timer: leaving them
  // behind loads the very FSEvents queue the poll exists to cover for, and the
  // next test's watch is the one that pays for it.
  for (const domain of running.splice(0)) {
    domain.stop("peers");
    domain.stop("agents");
  }
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One harness state file, in the harness's own spelling — camelCase, its own
 * status words, and its own pid. The pid is this process's, because a row
 * whose process is gone is not a session that exists. */
function writeState(dir: string, pid: number, sid: Sid, extra: Record<string, unknown> = {}) {
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: sid,
      cwd: "/Users/someone/.local/share/repos/github.com/someone/a-repo/main",
      kind: "interactive",
      startedAt: 1_757_000_000_000,
      status: "idle",
      ...extra,
    }),
  );
}

interface Published {
  topic: string;
  data: unknown;
}

/** A `Sessions` with somewhere to publish and a poll fast enough that a test
 * does not depend on `fs.watch` being prompt. Both routes are live: a test
 * asserting the watch itself sets `pollMs` high. */
function sessions(overrides: { pollMs?: number; gateway?: GatewaySource } = {}) {
  const dirs = home();
  const published: Published[] = [];
  const waiters: (() => void)[] = [];
  const domain = new Sessions({
    self: SELF,
    configHome: dirs.root,
    stateDir: dirs.stateDir,
    capabilities: [],
    version: "0.0.1",
    startedAt: 1_757_000_000_000,
    publish: (topic, data) => {
      published.push({ topic, data });
      for (const waiter of waiters.splice(0)) waiter();
    },
    pollMs: overrides.pollMs ?? 50,
    ...(overrides.gateway === undefined ? {} : { gateway: overrides.gateway }),
  });
  running.push(domain);
  /** Resolves when a publish satisfying `want` has happened, waiting for the
   * next one rather than polling for it. */
  const until = async (want: (frames: Published[]) => boolean) => {
    while (!want(published)) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return published;
  };
  return { ...dirs, domain, published, until };
}

/** The same instance again: a new daemon over the same config home and state
 * directory, which is all a restart is. */
function restart(context: { root: string; stateDir: string }): Sessions {
  const domain = new Sessions({
    self: SELF,
    configHome: context.root,
    stateDir: context.stateDir,
    capabilities: [],
    version: "0.0.1",
    startedAt: 1_757_000_000_000,
    publish: () => {},
  });
  running.push(domain);
  return domain;
}

function helloFrom(domain: Sessions, conn: TestConn, sid: Sid = SID): HelloResult {
  return domain.hello({
    op: "hello",
    conn,
    args: {
      op: "hello",
      request_id: "1",
      role: "session",
      protocol_version: PROTOCOL_VERSION,
      sid,
      ...META,
    },
  });
}

/** What a session states about itself when it greets — the contract's shared
 * session fields, which `peers` repeats under the same names. */
const META = {
  repo: "someone/a-repo",
  ws: "main",
  cwd: "/Users/someone/.local/share/repos/github.com/someone/a-repo/main",
  transcript_path: "/Users/someone/.claude/projects/a/b.jsonl",
  branch: "main",
  title: "a title",
  model: "a-model",
  effort: "high",
};

const peersOf = (frames: Published[]) => frames.filter((frame) => frame.topic === "peers");
const agentsOf = (frames: Published[]) => frames.filter((frame) => frame.topic === "agents");

describe("hello", () => {
  test("answers the contract's own result, naming only this instance", () => {
    const { domain } = sessions();
    const result = helloFrom(domain, connAs("session"));
    expect(
      validationErrors(OP_SCHEMAS.hello.response, { ok: true, request_id: "1", ...result }),
    ).toEqual([]);
    expect(result.instances.map((instance) => instance.id)).toEqual([SELF]);
    expect(result.instance).toBe(SELF);
  });

  test("a greeting that names no sid registers nothing", () => {
    // What registers a session is the sid it names, not the role it claims: a
    // person's greeting carries no sid and must not become a peer, and reading
    // the role to tell them apart would be the second place that rule lives (M1).
    const { domain } = sessions();
    domain.hello({
      op: "hello",
      conn: connAs("user"),
      args: { op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION },
    });
    expect(domain.peers().peers).toEqual([]);
  });

  test("a greeting announcing another generation is refused", () => {
    const { domain } = sessions();
    expect(() =>
      domain.hello({
        op: "hello",
        conn: connAs("session"),
        args: { op: "hello", request_id: "1", role: "session", protocol_version: 99, sid: SID },
      }),
    ).toThrow();
  });

  test("what the greeting said about the session is what peers repeats", () => {
    const { domain } = sessions();
    helloFrom(domain, connAs("session"));
    const peer = domain.peers().peers[0];
    // Where it lives, which is what a connected row carries. What it runs as
    // (title, model, effort) belongs to `last_live`, where a resume reads it.
    const { title: _title, model: _model, effort: _effort, ...where } = META;
    expect(peer).toMatchObject(where);
  });

  test("a session that named none of it is shown without it, never with a guess", () => {
    const { domain } = sessions();
    domain.hello({
      op: "hello",
      conn: connAs("session"),
      args: {
        op: "hello",
        request_id: "1",
        role: "session",
        protocol_version: PROTOCOL_VERSION,
        sid: SID,
      },
    });
    const peer = domain.peers().peers[0];
    expect(peer).toMatchObject({ repo: "", ws: "", cwd: "" });
    expect(peer?.repo_root).toBeUndefined();
    expect(peer?.branch).toBeUndefined();
  });

  test("a session that greeted is a peer, and stops being one when it closes", () => {
    const { domain } = sessions();
    const conn = connAs("session");
    helloFrom(domain, conn);
    expect(domain.peers().peers.map((peer) => peer.sid)).toEqual([SID]);
    conn.close();
    expect(domain.peers().peers).toEqual([]);
  });
});

describe("the harness's sessions directory", () => {
  test("a state file appearing, changing and going away each states peers", async () => {
    const context = sessions();
    context.domain.start("peers");
    writeState(context.sessionsDir, process.pid, SID);
    await context.until(
      (frames) =>
        peersOf(frames).length > 0 &&
        agentsOf(frames).some((frame) => (frame.data as { agents: unknown[] }).agents.length === 1),
    );

    writeState(context.sessionsDir, process.pid, SID, {
      status: "waiting",
      waitingFor: "a choice",
    });
    await context.until(() => context.domain.classify(SID) === "waiting");

    rmSync(join(context.sessionsDir, `${process.pid}.json`));
    await context.until(() => context.domain.agents().agents.length === 0);
    expect(context.domain.classify(SID)).toBe("disappeared");
  });

  test("the payloads pass the contract's own validators", async () => {
    const context = sessions();
    helloFrom(context.domain, connAs("session"));
    context.domain.start("agents");
    writeState(context.sessionsDir, process.pid, OTHER_SID, { name: "a title" });
    await context.until(() => context.domain.agents().agents.length === 1);

    expect(validationErrors(TOPIC_SCHEMAS.peers, frame("peers", context.domain.peers()))).toEqual(
      [],
    );
    expect(
      validationErrors(TOPIC_SCHEMAS.agents, frame("agents", context.domain.agents())),
    ).toEqual([]);
    const peer = context.domain.peers().peers[0];
    expect(peer?.protocol_version).toBe(PROTOCOL_VERSION);
  });

  test("a row whose process is gone is not a session that exists", async () => {
    const context = sessions();
    context.domain.start("agents");
    // A pid nothing runs under is what a state file left behind by a session
    // that did not clean up after itself looks like.
    writeState(context.sessionsDir, 2_147_483_646, SID);
    writeState(context.sessionsDir, process.pid, OTHER_SID);
    await context.until(() => context.domain.agents().agents.length > 0);
    expect(context.domain.agents().agents.map((agent) => agent.sid)).toEqual([OTHER_SID]);
  });

  test("the file watch alone carries a change, with the poll too slow to help", async () => {
    // Far beyond this test's own timeout, so a publish arriving here came from
    // `fs.watch` and from nothing else.
    const context = sessions({ pollMs: 600_000 });
    context.domain.start("peers");
    await context.until(() => context.published.length > 0);
    const before = context.published.length;
    writeState(context.sessionsDir, process.pid, SID);
    await context.until(
      (frames) => frames.length > before && context.domain.agents().agents.length === 1,
    );
  });

  test("the watch runs while a subscriber holds either topic, and not otherwise", () => {
    const context = sessions();
    const hub = new Topics(SELF, new Set());
    hub.attach("peers", context.domain);
    hub.attach("agents", context.domain);
    expect(context.domain.watching).toBe(false);

    const user = connAs("user");
    expect(hub.subscribe(user, "peers")).toBe("ok");
    expect(hub.subscribe(user, "agents")).toBe("ok");
    expect(context.domain.watching).toBe(true);

    hub.unsubscribe(user, "peers");
    expect(context.domain.watching).toBe(true);
    hub.unsubscribe(user, "agents");
    expect(context.domain.watching).toBe(false);
  });

  test("a subscriber's snapshot is the current value, per topic", () => {
    const context = sessions();
    const hub = new Topics(SELF, new Set());
    hub.attach("peers", context.domain);
    helloFrom(context.domain, connAs("session"));

    const user = connAs("user");
    hub.subscribe(user, "peers");
    user.flush();
    const snapshot = user.topics()[0] as { snapshot: boolean; data: { peers: unknown[] } };
    expect(snapshot.snapshot).toBe(true);
    expect(snapshot.data.peers).toHaveLength(1);
  });
});

describe("the classification on the wire", () => {
  test("every row of both lists states its state and whether it is pinned", async () => {
    const context = sessions();
    const connected = connAs("session");
    helloFrom(context.domain, connected);
    const gone = connAs("session", OTHER_SID);
    helloFrom(context.domain, gone, OTHER_SID);
    gone.close();
    context.domain.start("peers");
    writeState(context.sessionsDir, process.pid, SID, {
      status: "waiting",
      waitingFor: "a choice",
    });
    await context.until(() => context.domain.classify(SID) === "waiting");

    const payload = context.domain.peers();
    for (const row of [...payload.peers, ...payload.last_live]) {
      expect(row.state).toBeDefined();
      expect(row.pinned).toBe(false);
    }
    expect(payload.peers[0]?.state).toBe("waiting");
    expect(payload.last_live[0]?.state).toBe("disappeared");
  });

  test("a session that said it was stopping travels as paused, with when it said so", () => {
    const context = sessions();
    const conn = connAs("session");
    helloFrom(context.domain, conn);
    conn.close();
    context.domain.markStopped(SID, NOW);
    const entry = context.domain.peers().last_live[0];
    expect(entry?.state).toBe("paused");
    expect(entry?.stopped_at).toBe(NOW);
  });

  test("what the session ran as follows it into last_live", () => {
    const context = sessions();
    const conn = connAs("session");
    helloFrom(context.domain, conn);
    conn.close();
    expect(context.domain.peers().last_live[0]).toMatchObject({
      title: META.title,
      model: META.model,
      effort: META.effort,
      repo: META.repo,
    });
  });
});

describe("last_live", () => {
  test("a session that greeted and went away survives a restart as Disappeared", () => {
    const context = sessions();
    const conn = connAs("session");
    helloFrom(context.domain, conn);
    conn.close();
    expect(context.domain.classify(SID)).toBe("disappeared");

    const restarted = restart(context);
    expect(restarted.classify(SID)).toBe("disappeared");
    expect(restarted.markStopped(SID)).toBe(true);
    expect(restarted.classify(SID)).toBe("paused");
    // And it leaves the list the moment the session registers again.
    helloFrom(restarted, connAs("session"));
    expect(restarted.peers().last_live).toEqual([]);
  });

  test("an entry past the retention window is dropped", () => {
    const { stateDir } = home();
    const file = join(stateDir, "last-live.json");
    const store = new LastLiveStore(file);
    const now = 1_800_000_000_000;
    store.record({ sid: SID, instance: SELF, repo: "", ws: "", cwd: "", last_seen_at: now });
    expect(store.entries(now).map((entry) => entry.sid)).toEqual([SID]);
    expect(store.entries(now + LAST_LIVE_RETENTION_MS + 1)).toEqual([]);

    const reloaded = new LastLiveStore(file);
    reloaded.load(now + LAST_LIVE_RETENTION_MS + 1);
    expect(reloaded.entries(now)).toEqual([]);
  });

  test("nothing but the three kinds of §3.6 is written, across a restart", () => {
    const context = sessions();
    const conn = connAs("session");
    helloFrom(context.domain, conn);
    conn.close();
    context.domain.start("peers");
    context.domain.stop("peers");

    const restarted = restart(context);
    restarted.start("peers");
    restarted.stop("peers");
    expect(readdirSync(context.stateDir)).toEqual(["last-live.json"]);
  });
});

describe("the inputs of §5.1", () => {
  test("what the gateway saw reaches the classification through the domain", () => {
    const seen = Date.now() - 1_000;
    const context = sessions({ gateway: { activeAt: (sid) => (sid === SID ? seen : undefined) } });

    expect(context.domain.inputs(SID).gateway_active_at).toBe(seen);
    // Nothing is connected and the harness holds no row, so this session is
    // alive on the gateway's word alone (§5.2).
    expect(context.domain.classify(SID)).toBe("live_unmanaged");
    expect(context.domain.inputs(OTHER_SID).gateway_active_at).toBeUndefined();
    expect(context.domain.classify(OTHER_SID)).toBeUndefined();
  });

  test("an instance with no gateway leaves the input absent rather than old", () => {
    const context = sessions();
    expect(context.domain.inputs(SID).gateway_active_at).toBeUndefined();
  });
});

describe("the derivation of §5.2", () => {
  const cases: [string, SessionInputs, SessionState | undefined][] = [
    ["a dialog is open", { connected: true, harness: { waiting: true } }, "waiting"],
    [
      "its last turn ended on an API error",
      { connected: true, harness: { waiting: false }, api_error_stopped: true },
      "waiting",
    ],
    ["it holds a connection", { connected: true }, "live"],
    [
      "the harness has it and names its terminal",
      { connected: false, harness: { waiting: false, terminal_id: "t1" } },
      "live",
    ],
    [
      "the harness has it but nothing can reach it",
      { connected: false, harness: { waiting: false } },
      "live_unmanaged",
    ],
    [
      "only the gateway has seen it lately",
      { connected: false, gateway_active_at: NOW - 1_000 },
      "live_unmanaged",
    ],
    ["it was stopped on purpose", { connected: false, last_live: { stopped_at: NOW } }, "paused"],
    ["it simply went away", { connected: false, last_live: {} }, "disappeared"],
    ["nobody has heard of it", { connected: false }, undefined],
  ];

  test.each(cases)("%s", (_name, inputs, expected) => {
    expect(classify(inputs, NOW)).toBe(expected as SessionState);
  });

  test("a session in last_live that is live again is not Paused", () => {
    expect(classify({ connected: true, last_live: { stopped_at: NOW } }, NOW)).toBe("live");
  });
});

const NOW = 1_800_000_000_000;

/** A topic payload as the frame carries it, which is what the contract's topic
 * schema describes. */
function frame(topic: string, data: unknown) {
  return { ev: "topic", topic, snapshot: true, instance: SELF, data };
}
