import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { OpError } from "../src/dispatch/index.ts";
import { Topics } from "../src/topics/index.ts";
import {
  classify,
  type GatewaySource,
  LastLiveStore,
  type SessionInputs,
  Sessions,
} from "../src/sessions/index.ts";
import { connAs, greeting, SELF, SID, OTHER_SID, TestConn } from "./frames.ts";

/** A throwaway config home under the OS temp dir, which is where the harness's
 * `sessions/` and this instance's state directory both hang. */
function home() {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-sessions-"));
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  // The transcript a greeting names is taken only where it is a file under this
  // config home's `projects/` (M6), so a fixture that wants it taken writes one.
  mkdirSync(join(root, "projects", "a"), { recursive: true });
  writeFileSync(join(root, "projects", "a", "b.jsonl"), "");
  // Resolved, because what the instance keeps is the file it will read rather
  // than the spelling it was handed.
  transcriptPath = realpathSync(join(root, "projects", "a", "b.jsonl"));
  homes.push(root);
  return { root, sessionsDir, stateDir: join(root, "state") };
}

/** The transcript of the config home the fixture most recently made. */
let transcriptPath = "";

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

/** `session_stopping`, spoken on a connection that has already greeted — which
 * is the only way it is reachable: the op takes its subject from the identity
 * the connection settled, never from an argument. */
function declareStopping(domain: Sessions, conn: TestConn, sid: Sid = SID) {
  return domain.stopping({
    op: "session_stopping",
    conn,
    args: { op: "session_stopping", request_id: "1" },
    identity: { state: "settled", role: "session", sid },
  });
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
      ...meta(),
    },
  });
}

/** What a session states about itself when it greets — the contract's shared
 * session fields, which `peers` repeats under the same names. */
function meta() {
  return {
    repo: "someone/a-repo",
    ws: "main",
    cwd: "/Users/someone/.local/share/repos/github.com/someone/a-repo/main",
    transcript_path: transcriptPath,
    branch: "main",
    title: "a title",
    model: "a-model",
    effort: "high",
  };
}

const peersOf = (frames: Published[]) => frames.filter((frame) => frame.topic === "peers");
const agentsOf = (frames: Published[]) => frames.filter((frame) => frame.topic === "agents");

describe("hello", () => {
  test("answers the contract's own result, naming only this instance", () => {
    const { domain } = sessions();
    const result = helloFrom(domain, greeting());
    expect(
      validationErrors(OP_SCHEMAS.hello.response, { ok: true, request_id: "1", ...result }),
    ).toEqual([]);
    expect(result.instances.map((instance) => instance.id)).toEqual([SELF]);
    expect(result.instance).toBe(SELF);
  });

  test("a person's greeting registers nothing", () => {
    const { domain } = sessions();
    domain.hello({
      op: "hello",
      conn: greeting(),
      args: { op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION },
    });
    expect(domain.peers().peers).toEqual([]);
  });

  test("each role says what its own greeting has to carry", () => {
    // The greeting is the one frame whose shape depends on the role, and the
    // contract's schema cannot say so: one schema covers all three roles, which
    // is why every one of these fields is optional in it.
    const { domain } = sessions();
    const greet = (args: Record<string, unknown>) => () =>
      domain.hello({
        op: "hello",
        conn: greeting(),
        args: { op: "hello", request_id: "1", protocol_version: PROTOCOL_VERSION, ...args },
      });
    // A session without a sid is a session this instance cannot speak about.
    expect(greet({ role: "session" })).toThrow(OpError);
    // A sid on a person's greeting would be a person registering as the session.
    expect(greet({ role: "user", sid: SID })).toThrow(OpError);
    // A peer greets with its claim, and a claim alone proves nothing: the
    // exchange that would bind this connection to it does not exist yet, so
    // either shape of an instance greeting is refused.
    expect(greet({ role: "instance" })).toThrow(OpError);
    expect(
      greet({
        role: "instance",
        mesh: { ver: 1, iss: SELF, aud: SELF, kid: "0123456789abcdef" },
      }),
    ).toThrow(OpError);
    expect(domain.peers().peers).toEqual([]);
  });

  test("a connection greets once, and a second greeting is refused", () => {
    // The role is set by `hello` and fixed for the connection's life (contract,
    // `Role`), so a second greeting is a request to become somebody else on a
    // connection that already is somebody.
    const { domain } = sessions();
    const conn = greeting();
    helloFrom(domain, conn);
    // What the driver does when the reply goes out.
    conn.identity = { state: "settled", role: "session", sid: SID };
    expect(() => helloFrom(domain, conn)).toThrow(OpError);
  });

  test("a transcript under another config home is named, not read (M6)", () => {
    // How a session describes itself is its own business; what this instance
    // acts on is not. A path outside this config home's `projects/` is left
    // unstated rather than refused — the greeting is not wrong, it just names
    // a file this instance will not open.
    const context = sessions();
    // Another instance's config home, with a real transcript in it.
    const elsewhere = mkdtempSync(join(tmpdir(), "ccmsg-other-home-"));
    homes.push(elsewhere);
    mkdirSync(join(elsewhere, "projects", "a"), { recursive: true });
    writeFileSync(join(elsewhere, "projects", "a", "b.jsonl"), "");
    context.domain.hello({
      op: "hello",
      conn: greeting(),
      args: {
        op: "hello",
        request_id: "1",
        role: "session",
        protocol_version: PROTOCOL_VERSION,
        sid: SID,
        transcript_path: join(elsewhere, "projects", "a", "b.jsonl"),
      },
    });
    expect(context.domain.transcriptPath(SID)).toBeUndefined();
    expect(context.domain.peers().peers[0]?.transcript_path).toBeUndefined();
  });

  test("every request restamps the session's last activity", () => {
    // `last_activity_at` is the most recent request on any of the session's
    // connections, which is a different question from when a person last spoke
    // to it (§5.3).
    const { domain } = sessions();
    helloFrom(domain, greeting());
    const greeted = domain.peers().peers[0]?.last_activity_at ?? 0;
    domain.touch(SID, greeted + 5_000);
    expect(domain.peers().peers[0]?.last_activity_at).toBe(greeted + 5_000);
    // A session nothing knows about is not invented by being touched.
    domain.touch(OTHER_SID, greeted + 5_000);
    expect(domain.peers().peers).toHaveLength(1);
  });

  test("a greeting announcing another generation is refused", () => {
    const { domain } = sessions();
    expect(() =>
      domain.hello({
        op: "hello",
        conn: greeting(),
        args: { op: "hello", request_id: "1", role: "session", protocol_version: 99, sid: SID },
      }),
    ).toThrow();
  });

  test("what the greeting said about the session is what peers repeats", () => {
    const { domain } = sessions();
    helloFrom(domain, greeting());
    const peer = domain.peers().peers[0];
    // Where it lives and what it calls itself. What it runs as (model, effort)
    // belongs to `last_live` alone, where a resume reads it.
    const { model: _model, effort: _effort, ...shown } = meta();
    expect(peer).toMatchObject(shown);
  });

  test("a peer carries what the gateway last saw run for it", () => {
    const seen = NOW - 1_000;
    const { domain } = sessions({
      gateway: { activeAt: (sid) => (sid === SID ? seen : undefined) },
    });
    helloFrom(domain, greeting());
    expect(domain.peers().peers[0]?.gateway_active_at).toBe(seen);
  });

  test("an instance with no gateway shows the peer without the mark, not as quiet", () => {
    const { domain } = sessions();
    helloFrom(domain, greeting());
    expect(domain.peers().peers[0]?.gateway_active_at).toBeUndefined();
  });

  test("a session that named none of it is shown without it, never with a guess", () => {
    const { domain } = sessions();
    domain.hello({
      op: "hello",
      conn: greeting(),
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
    const conn = greeting();
    helloFrom(domain, conn);
    expect(domain.peers().peers.map((peer) => peer.sid)).toEqual([SID]);
    conn.close();
    expect(domain.peers().peers).toEqual([]);
  });
});

describe("the harness's sessions directory", () => {
  /** Which sessions exist is a fact about this config home, not a thing the
   * watch produces (§5.1). The watch runs only while somebody is subscribed
   * (§6.3), and these are what goes wrong when the two are confused: a live
   * session that nobody happens to be watching becomes a session nobody can
   * be sent a message, and a session that is plainly still running gets
   * written down as gone. */
  test("a session the harness has is classified with nobody subscribed", () => {
    const context = sessions();
    writeState(context.sessionsDir, process.pid, SID);

    expect(context.domain.watching).toBe(false);
    expect(context.domain.classify(SID)).toBe("live_unmanaged");
    expect(context.domain.agents().agents.map((row) => row.sid)).toEqual([SID]);
  });

  test("a session still in the directory is not written down as gone when its connection closes", () => {
    const context = sessions();
    writeState(context.sessionsDir, process.pid, SID);
    // A greeting that closes at once is what a command-line client is: it
    // greets, says its piece and goes, while the session it spoke for carries
    // on. What is gone is a connection, not a session.
    const conn = greeting();
    helloFrom(context.domain, conn);
    conn.close();

    expect(context.domain.classify(SID)).toBe("live_unmanaged");
    expect(context.domain.peers().last_live).toEqual([]);
  });

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
    // The row is gone from the directory the moment the file is, and reading
    // it says so at once. What takes a turn of the watch is the recording that
    // follows: a session stops being live, and the entry that outlives it is
    // written where that is noticed.
    await context.until(() => context.domain.classify(SID) === "disappeared");
    expect(context.domain.agents().agents).toEqual([]);
  });

  test("the payloads pass the contract's own validators", async () => {
    const context = sessions();
    helloFrom(context.domain, greeting());
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
    helloFrom(context.domain, greeting());

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
    const connected = greeting();
    helloFrom(context.domain, connected);
    const gone = greeting();
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
    const conn = greeting();
    helloFrom(context.domain, conn);
    // The declaration comes first and the departure second, which is the order
    // the two are one event in (contract, `session_stopping`).
    const declared = declareStopping(context.domain, conn);
    conn.close();
    const entry = context.domain.peers().last_live[0];
    expect(entry?.state).toBe("paused");
    expect(entry?.stopped_at).toBe(declared.stopped_at);
  });

  test("a session that just went away is Disappeared, not Paused", () => {
    const context = sessions();
    const conn = greeting();
    helloFrom(context.domain, conn);
    conn.close();
    const entry = context.domain.peers().last_live[0];
    expect(entry?.state).toBe("disappeared");
    expect(entry?.stopped_at).toBeUndefined();
  });

  test("a session that said it was stopping and carried on is still live", () => {
    const context = sessions();
    const conn = greeting();
    helloFrom(context.domain, conn);
    declareStopping(context.domain, conn);
    expect(context.domain.classify(SID)).toBe("live");
    expect(context.domain.peers().last_live).toEqual([]);
  });

  test("what the session ran as follows it into last_live", () => {
    const context = sessions();
    const conn = greeting();
    helloFrom(context.domain, conn);
    conn.close();
    const greeted = meta();
    expect(context.domain.peers().last_live[0]).toMatchObject({
      title: greeted.title,
      model: greeted.model,
      effort: greeted.effort,
      repo: greeted.repo,
    });
  });
});

describe("last_live", () => {
  test("a session that greeted and went away survives a restart as Disappeared", () => {
    const context = sessions();
    const conn = greeting();
    helloFrom(context.domain, conn);
    conn.close();
    expect(context.domain.classify(SID)).toBe("disappeared");

    const restarted = restart(context);
    expect(restarted.classify(SID)).toBe("disappeared");
    // And it leaves the list the moment the session registers again.
    helloFrom(restarted, greeting());
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
    const conn = greeting();
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
