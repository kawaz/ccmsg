import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HelloResult,
  LAST_LIVE_RETENTION_MS,
  type LastLiveSession,
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
  HarnessSessions,
  LastLiveStore,
  type SessionInputs,
  Sessions,
  hostTerminalReader,
  type TerminalReader,
} from "../src/sessions/index.ts";
import { NO_FACTS, type TranscriptFacts } from "../src/transcript/index.ts";
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
const watchers: HarnessSessions[] = [];
const children: number[] = [];

/** A harness directory of a config home nothing else in the case uses, for the
 * two cases that drive `HarnessSessions` itself rather than a whole `Sessions`.
 * Left uncreated where the case is about a watch with nothing to attach to. */
function harnessDir(prefix: string, options: { create?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  homes.push(root);
  const dir = join(root, "sessions");
  if (options.create !== false) mkdirSync(dir, { recursive: true });
  return dir;
}

/** A real `HarnessSessions` over `dir` that counts what it reports and lets a
 * case wait for the next report rather than poll for one. */
function watchOf(dir: string, pollMs: number) {
  const waiters: (() => void)[] = [];
  let changes = 0;
  const harness = new HarnessSessions(
    dir,
    SELF,
    () => {
      changes++;
      for (const waiter of waiters.splice(0)) waiter();
    },
    pollMs,
  );
  watchers.push(harness);
  return {
    harness,
    /** Whether a report arrived within `budgetMs`. Running out is an answer
     * rather than a failure: a watch may drop a change outright (§5.1), so a
     * case that reads this decides for itself what a miss means. */
    reported: async (budgetMs: number): Promise<boolean> => {
      const before = changes;
      await Promise.race([
        new Promise<void>((resolve) => waiters.push(resolve)),
        Bun.sleep(budgetMs),
      ]);
      return changes > before;
    },
  };
}

/** A process of this test's own to read a terminal out of, with whatever
 * environment the case is about. Nothing is ever signalled through it: what is
 * being read is the environment of a pid the harness's directory names. */
async function child(env: Record<string, string>): Promise<number> {
  // This test process may itself be running in a terminal the daemon would
  // read, and a child inherits what names it. What the case is about is what
  // the case states, so the inherited names go first.
  const outside = { ...process.env };
  delete outside["HYOUI_SESSION_ID"];
  delete outside["HYOUI_NAMESPACE"];
  const ready = `ccmsg-test-${crypto.randomUUID()}`;
  const spawned = Bun.spawn(["sleep", "30"], {
    env: { ...outside, ...env, CCMSG_TEST_CHILD_READY: ready },
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(spawned.pid);
  if (process.platform === "linux") {
    const record = `CCMSG_TEST_CHILD_READY=${ready}`;
    while (!(await Bun.file(`/proc/${spawned.pid}/environ`).text()).split("\0").includes(record)) {}
  }
  return spawned.pid;
}
afterEach(() => {
  // A watch left running is a real file watch and a real timer: leaving them
  // behind loads the very FSEvents queue the poll exists to cover for, and the
  // next test's watch is the one that pays for it.
  for (const domain of running.splice(0)) {
    domain.stop("peers");
    domain.stop("agents");
  }
  for (const harness of watchers.splice(0)) harness.stop();
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is nothing this test needed it for.
    }
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

/** A greeting that states one thing about itself and nothing else, for the
 * cases about what the instance does with that one field. */
function greetWith(domain: Sessions, meta: Record<string, string>, sid: Sid = SID) {
  void domain.hello({
    op: "hello",
    conn: greeting(),
    args: {
      op: "hello",
      request_id: "1",
      role: "session",
      protocol_version: PROTOCOL_VERSION,
      sid,
      ...meta,
    },
  });
}

interface Published {
  topic: string;
  data: unknown;
}

/** A `Sessions` with somewhere to publish and a poll fast enough that a test
 * does not depend on `fs.watch` being prompt. Both routes are live: a test
 * asserting the watch itself sets `pollMs` high. */
function sessions(
  overrides: {
    pollMs?: number;
    gateway?: GatewaySource;
    terminals?: TerminalReader;
    transcript?: { facts: (sid: Sid) => TranscriptFacts };
  } = {},
) {
  const dirs = home();
  const published: Published[] = [];
  const waiters: (() => void)[] = [];
  const domain = new Sessions({
    self: SELF,
    endpoint: "https://host.example.ts.net/ccmsg/personal/",
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
    ...(overrides.terminals === undefined ? {} : { terminals: overrides.terminals }),
    ...(overrides.transcript === undefined ? {} : { transcript: overrides.transcript }),
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
    endpoint: "https://host.example.ts.net/ccmsg/personal/",
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
  // A session's greeting is answered without waiting for anything; only a
  // peer's is a promise (mesh-peer-auth §5).
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
  }) as HelloResult;
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
    void domain.hello({
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
      void domain.hello({
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
    void context.domain.hello({
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

  test("a transcript inside projects/ is taken before anything is written to it", () => {
    // The greeting a session-start hook makes: the harness has not created the
    // file yet, and the path is still inside the tree this instance reads. The
    // boundary is where the file goes, not whether it is there — nothing is
    // read early by taking it, since the tail is what opens it.
    const context = sessions();
    const unwritten = join(context.root, "projects", "a", "not-yet.jsonl");
    greetWith(context.domain, { transcript_path: unwritten });
    expect(context.domain.transcriptPath(SID)).toBe(
      join(realpathSync(join(context.root, "projects", "a")), "not-yet.jsonl"),
    );
  });

  test("nor does the directory it goes in have to exist yet", () => {
    // What a session-start hook actually names: at that instant the harness has
    // made neither the file nor the per-project directory it goes in.
    const context = sessions();
    const unwritten = join(context.root, "projects", "-not-created-yet", "b.jsonl");
    greetWith(context.domain, { transcript_path: unwritten });
    expect(context.domain.transcriptPath(SID)).toBe(
      join(realpathSync(join(context.root, "projects")), "-not-created-yet", "b.jsonl"),
    );
  });

  test("an unwritten path that climbs back out of the tree is refused", () => {
    const context = sessions();
    // Spelled inside `projects/` and pointing outside it. Nothing along the
    // way exists, so what settles it is where the whole path lands.
    greetWith(context.domain, {
      transcript_path: join(context.root, "projects", "nope", "..", "..", "..", "b.jsonl"),
    });
    expect(context.domain.transcriptPath(SID)).toBeUndefined();
  });

  test("a later greeting that says less does not take back what an earlier one said", () => {
    // The three processes of one session: the hook that knows the transcript,
    // a `post` that knows only where it runs, and a hook again. None of them
    // knows every field, so silence is "unchanged" rather than "withdrawn".
    const context = sessions();
    greetWith(context.domain, { transcript_path: transcriptPath, repo: "a-repo", ws: "main" });

    greetWith(context.domain, { cwd: "/somewhere/else" });

    expect(context.domain.transcriptPath(SID)).toBe(transcriptPath);
    expect(context.domain.peers().peers[0]).toMatchObject({
      repo: "a-repo",
      ws: "main",
      cwd: "/somewhere/else",
    });
  });

  test("a field a greeting does name is the one that changes", () => {
    const context = sessions();
    greetWith(context.domain, { repo: "a-repo", ws: "main", title: "the first title" });

    greetWith(context.domain, { title: "renamed" });

    expect(context.domain.peers().peers[0]).toMatchObject({
      repo: "a-repo",
      ws: "main",
      title: "renamed",
    });
  });

  test("a path outside projects/ is left unstated whether or not it is there", () => {
    const context = sessions();
    const elsewhere = mkdtempSync(join(tmpdir(), "ccmsg-other-home-"));
    homes.push(elsewhere);
    greetWith(context.domain, { transcript_path: join(elsewhere, "not-yet.jsonl") });
    expect(context.domain.transcriptPath(SID)).toBeUndefined();
  });

  test("a directory that links out of the tree resolves out of it and is refused", () => {
    const context = sessions();
    const elsewhere = mkdtempSync(join(tmpdir(), "ccmsg-other-home-"));
    homes.push(elsewhere);
    // A link sitting inside `projects/` is spelled inside it and is not: what
    // is compared is where the path resolves to.
    symlinkSync(elsewhere, join(context.root, "projects", "out"));
    greetWith(context.domain, {
      transcript_path: join(context.root, "projects", "out", "b.jsonl"),
    });
    expect(context.domain.transcriptPath(SID)).toBeUndefined();
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
    expect(
      () =>
        void domain.hello({
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
    void domain.hello({
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

  /** The two routes of §5.1, each pinned by what it alone is answerable for.
   *
   * A watch on a directory may simply not report a change: on macOS the event
   * is dropped outright rather than delivered late, so no amount of waiting
   * turns a miss into an arrival. That is the premise the poll exists under,
   * and it is why neither case below asks the watch to carry a particular
   * change — the poll is answerable for every change, and the watch only for
   * being a route at all. */
  test("a change the watch never sees is still carried, by the poll behind it", async () => {
    // A config home whose harness has not run: `fs.watch` has no directory to
    // attach to, so it is not watching and cannot report anything that follows.
    // This is the miss the poll covers, made total rather than occasional.
    const dir = harnessDir("ccmsg-poll-", { create: false });
    const watch = watchOf(dir, 20);
    watch.harness.start();

    mkdirSync(dir, { recursive: true });
    writeState(dir, process.pid, SID);
    while (watch.harness.scan().size !== 1) await watch.reported(5_000);
  });

  test("the watch is a live route, so not every change waits for the poll", async () => {
    // Far beyond this test's own budget, so anything reported here came from
    // `fs.watch` and from nothing else.
    const dir = harnessDir("ccmsg-watch-");
    const watch = watchOf(dir, 600_000);
    watch.harness.start();

    // Measured on macOS/Bun: a change the watch does report arrives within
    // ~50ms, and about one in twenty is dropped entirely while the suite loads
    // the FSEvents queue. Asserting that one particular change arrives is
    // asserting on that coin; that ten in a row are all dropped is what this
    // rules out, and what would be true of a route that was not wired at all.
    let carried = false;
    for (let attempt = 0; attempt < 10 && !carried; attempt++) {
      writeState(dir, process.pid, `${SID}-${attempt}`);
      carried = await watch.reported(1_000);
    }
    expect(carried).toBe(true);
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

  test("what it ran as is the transcript's last turn, not what it greeted as", () => {
    // The greeting names one instant; `/model` moves the session afterwards
    // without greeting again, so a resume reads the transcript.
    const facts: TranscriptFacts = { ...NO_FACTS, model: "claude-opus-5", effort: "xhigh" };
    const context = sessions({ transcript: { facts: () => facts } });
    const conn = greeting();
    helloFrom(context.domain, conn);
    conn.close();
    expect(context.domain.peers().last_live[0]).toMatchObject({
      model: "claude-opus-5",
      effort: "xhigh",
    });
  });

  test("a transcript nothing has read leaves the greeting standing", () => {
    const context = sessions({ transcript: { facts: () => NO_FACTS } });
    const conn = greeting();
    helloFrom(context.domain, conn);
    conn.close();
    const greeted = meta();
    expect(context.domain.peers().last_live[0]).toMatchObject({
      model: greeted.model,
      effort: greeted.effort,
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
    // The harness naming it is what makes it a session of this config home;
    // without that the gateway's word says nothing here (§5.1).
    writeState(context.sessionsDir, process.pid, SID);

    expect(context.domain.inputs(SID).gateway_active_at).toBe(seen);
    expect(context.domain.inputs(OTHER_SID).gateway_active_at).toBeUndefined();
    expect(context.domain.classify(OTHER_SID)).toBeUndefined();
  });

  test("a session that greeted keeps the gateway's word after it disconnects", () => {
    const seen = Date.now() - 1_000;
    const context = sessions({ gateway: { activeAt: () => seen } });
    const conn = greeting();
    helloFrom(context.domain, conn);

    expect(context.domain.inputs(SID).gateway_active_at).toBe(seen);
    // Gone from the connections but remembered in `last_live`, which is still
    // this instance knowing whose sid that is.
    conn.close();
    expect(context.domain.inputs(SID).gateway_active_at).toBe(seen);
    // Alive on the gateway's word alone, now that nothing else holds it (§5.2).
    expect(context.domain.classify(SID)).toBe("live_unmanaged");
  });

  test("the gateway cannot make a session of another config home live here", () => {
    const seen = Date.now() - 1_000;
    // The gateway sees every config home and its events name only a sid, so it
    // answers for one this instance has never heard of.
    const context = sessions({ gateway: { activeAt: () => seen } });

    expect(context.domain.inputs(OTHER_SID).gateway_active_at).toBeUndefined();
    expect(context.domain.classify(OTHER_SID)).toBeUndefined();
    // Nothing greeted, so nothing is on `peers` either — the row the gateway
    // would otherwise have put there is what makes the sid addressable.
    expect(context.domain.peers(Date.now()).peers).toEqual([]);
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

describe("the terminal a live session runs in", () => {
  /** The domain with the host's own reader and no confirmation poll: a publish
   * then comes from one place only, which is a read of a process finishing.
   * Waiting for that beats waiting for a length of time. */
  function withTerminals(reads: number[] = []) {
    const host = hostTerminalReader();
    const read: TerminalReader = async (pid) => {
      reads.push(pid);
      return await host(pid);
    };
    return { ...sessions({ pollMs: 600_000, terminals: read }), reads };
  }

  test("a session whose process names one is reachable, and says which terminal", async () => {
    const context = withTerminals();
    const pid = await child({ HYOUI_SESSION_ID: "t-1", HYOUI_NAMESPACE: "work" });
    writeState(context.sessionsDir, pid, SID);

    // The scan is what notices the pid, and the read is what follows it.
    expect(context.domain.agents().agents[0]?.terminal_id).toBeUndefined();
    await context.until(() => context.domain.agents().agents[0]?.terminal_id === "t-1");
    expect(context.domain.agents().agents[0]?.terminal_namespace).toBe("work");
    // Reachable through its terminal with no connection to this instance,
    // which is the whole of what the terminal is read for (§5.2).
    expect(context.domain.classify(SID)).toBe("live");
  });

  test("a session whose process names none stays the one nothing can reach", async () => {
    const context = withTerminals();
    const pid = await child({});
    writeState(context.sessionsDir, pid, SID);
    // The read is asked for while the list is built, and its finishing is the
    // one thing that publishes here.
    context.domain.agents();
    await context.until((frames) => agentsOf(frames).length > 0);

    const row = context.domain.agents().agents[0];
    expect(row?.sid).toBe(SID);
    expect(row?.terminal_id).toBeUndefined();
    expect(context.domain.classify(SID)).toBe("live_unmanaged");
  });

  test("a process is read once, however many questions are asked of the list", async () => {
    const reads: number[] = [];
    const context = withTerminals(reads);
    const pid = await child({ HYOUI_SESSION_ID: "t-2" });
    writeState(context.sessionsDir, pid, SID);
    await context.until(() => context.domain.agents().agents[0]?.terminal_id === "t-2");
    for (let asked = 0; asked < 5; asked += 1) context.domain.classify(SID);
    expect(reads).toEqual([pid]);
  });

  test("a pid the harness no longer names is forgotten, so a resumed session is read afresh", async () => {
    const reads: number[] = [];
    const context = withTerminals(reads);
    const pid = await child({ HYOUI_SESSION_ID: "t-3" });
    writeState(context.sessionsDir, pid, SID);
    await context.until(() => context.domain.agents().agents[0]?.terminal_id === "t-3");

    rmSync(join(context.sessionsDir, `${pid}.json`));
    context.domain.agents();
    // The same pid again is a process this instance knows nothing about: what
    // it named before was named by whatever was running under it then.
    writeState(context.sessionsDir, pid, SID);
    context.domain.agents();
    await context.until(() => reads.length === 2);
    expect(reads).toEqual([pid, pid]);
  });
});

describe("what a session said about itself when it greeted", () => {
  /** The `last_live` rows of the most recent `peers` payload. */
  function lastLive(published: Published[]): LastLiveSession[] {
    const frames = peersOf(published);
    const data = frames.at(-1)?.data as { last_live?: LastLiveSession[] } | undefined;
    return data?.last_live ?? [];
  }

  test("outlives the connection that said it, while the harness still names the session", async () => {
    const context = sessions();
    writeState(context.sessionsDir, process.pid, SID);
    context.domain.start("peers");
    const conn = greeting();
    helloFrom(context.domain, conn, SID);

    // A session-start hook greets and leaves, and every client process of a
    // session comes and goes. Neither is the session ending.
    conn.close();

    expect(context.domain.transcriptPath(SID)).toBe(transcriptPath);
    expect(lastLive(context.published).some((row) => row.sid === SID)).toBe(false);

    // And when the harness stops naming it, the entry written carries what it
    // said rather than a bare sid.
    rmSync(join(context.sessionsDir, `${process.pid}.json`));
    const frames = await context.until((published) =>
      lastLive(published).some((row) => row.sid === SID),
    );
    expect(lastLive(frames).find((row) => row.sid === SID)).toMatchObject({
      repo: "someone/a-repo",
      ws: "main",
      branch: "main",
      title: "a title",
      transcript_path: transcriptPath,
      model: "a-model",
      effort: "high",
    });

    // Spent with that entry: the words were about a session this instance no
    // longer has, and a sid that comes back says them again.
    expect(context.domain.transcriptPath(SID)).toBeUndefined();
  });

  test("a session the harness names but that never greeted is shown without them", () => {
    const context = sessions();
    writeState(context.sessionsDir, process.pid, OTHER_SID);

    // Nothing is guessed out of the row's path: `repo` and `ws` are what a
    // session said, and this one has said nothing.
    expect(context.domain.transcriptPath(OTHER_SID)).toBeUndefined();
    expect(context.domain.agents().agents.map((row) => row.sid)).toEqual([OTHER_SID]);
  });
});
