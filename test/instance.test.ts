import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OP_NAMES, PROTOCOL_VERSION } from "@ccmsg/protocol";
import { DUMPS } from "../src/sessions/index.ts";
import { KV_DIR } from "../src/kv/index.ts";
import { OpError } from "../src/dispatch/index.ts";
import {
  completeHandlers,
  ConfigError,
  DEFAULT_CONFIG,
  type Env,
  Instance,
  isRunning,
  loadConfig,
  loadShared,
  MERGE_RULES,
  REAL_SOCKET,
  realSocketName,
  resolvePaths,
  saveShared,
  settingsFor,
  start,
} from "../src/instance/index.ts";
import { connectUds, type LineClient } from "./client.ts";
import { SID } from "./frames.ts";
import { reapOrphans, trackRoot } from "./harness.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** A config home nothing else has, with its state and config directories
 * beside it. Everything one instance touches is under here, which is what
 * makes "what did a run leave behind" a directory listing (M4). */
function disposable(): { env: Env; root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-instance-"));
  trackRoot(root);
  const home = join(root, "home");
  mkdirSync(join(home, "sessions"), { recursive: true });
  // What makes the directory a config home rather than any directory: the CLI
  // refuses to run an instance for one without it.
  writeFileSync(join(home, "settings.json"), "{}\n");
  return {
    root,
    home,
    env: {
      CLAUDE_CONFIG_DIR: home,
      CCMSG_STATE_DIR: join(root, "state"),
      CCMSG_CONFIG_DIR: join(root, "config"),
    },
  };
}

const running: Instance[] = [];
const clients: LineClient[] = [];

async function startAt(env: Env): Promise<Instance> {
  const outcome = await start({ env, echoLog: false });
  if (!isRunning(outcome)) throw new Error(`another instance holds this config home`);
  running.push(outcome);
  return outcome;
}

async function greet(instance: Instance): Promise<LineClient> {
  const client = await connectUds(instance.socketPath);
  clients.push(client);
  client.send({
    op: "hello",
    request_id: "hello",
    role: "user",
    protocol_version: PROTOCOL_VERSION,
  });
  const reply = await client.next();
  expect(reply["ok"]).toBe(true);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
});

// A daemon this file spawned and did not collect is a process left on the
// machine the run happened on. It is stopped here and named, so the run says so
// rather than ending green with the thing still holding a socket.
afterAll(async () => {
  expect(await reapOrphans()).toEqual([]);
});

describe("paths", () => {
  test("every path is derived from the config home (§8.1)", () => {
    const one = resolvePaths({ CLAUDE_CONFIG_DIR: "/homes/.claude-a", HOME: "/homes" });
    const two = resolvePaths({ CLAUDE_CONFIG_DIR: "/homes/.claude-b", HOME: "/homes" });
    expect(one.socket).not.toBe(two.socket);
    expect(one.stateDir).not.toBe(two.stateDir);
    // The config file is the exception: one file lists every instance, so it
    // is the one path two instances share.
    expect(one.configFile).toBe(two.configFile);
  });

  test("two config homes of the same name under different parents stay apart", () => {
    const one = resolvePaths({ CLAUDE_CONFIG_DIR: "/a/.claude" });
    const two = resolvePaths({ CLAUDE_CONFIG_DIR: "/b/.claude" });
    expect(one.key).not.toBe(two.key);
  });

  test("the app's own variable names the directory, XDG gets the app segments", () => {
    const direct = resolvePaths({ CLAUDE_CONFIG_DIR: "/h/.claude", CCMSG_STATE_DIR: "/somewhere" });
    expect(direct.stateDir).toBe("/somewhere");
    const xdg = resolvePaths({ CLAUDE_CONFIG_DIR: "/h/.claude", XDG_STATE_HOME: "/xdg/state" });
    expect(xdg.stateDir).toBe(join("/xdg/state", "ccmsg", xdg.key));
  });

  test("a relative XDG value is invalid and is ignored", () => {
    const paths = resolvePaths({ CLAUDE_CONFIG_DIR: "/h/.claude", XDG_STATE_HOME: "relative" });
    expect(paths.stateDir.startsWith("relative")).toBe(false);
  });

  test("the socket fits in sun_path even under a deep state directory", () => {
    const deep = join("/tmp", "x".repeat(200));
    const paths = resolvePaths({ CLAUDE_CONFIG_DIR: "/h/.claude", CCMSG_STATE_DIR: deep });
    expect(Buffer.byteLength(paths.socket)).toBeLessThan(104);
  });
});

describe("config", () => {
  /** The shared file, with one flat block of settings as the defaults. Every
   * instance sees them, which is what makes this the short way to write "an
   * instance configured like so". */
  function shared(root: string, defaults: Record<string, unknown>): string {
    const file = join(root, "config", "config.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(file, JSON.stringify({ defaults }));
    return file;
  }

  test("no config file is not a broken one", () => {
    const { root, home } = disposable();
    expect(loadConfig(join(root, "config", "config.json"), home)).toEqual(DEFAULT_CONFIG);
  });

  test("route (a) is on unless the config turns it off, and only by a boolean", () => {
    const { root, home } = disposable();
    expect(loadConfig(shared(root, {}), home).direct_delivery).toBe(true);
    expect(loadConfig(shared(root, { direct_delivery: false }), home).direct_delivery).toBe(false);
    const wrong = shared(root, { direct_delivery: "no" });
    expect(() => loadConfig(wrong, home)).toThrow(ConfigError);
  });

  test("a broken config throws rather than dropping the setting it carried", () => {
    const { root, home } = disposable();
    const file = join(root, "config", "config.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(file, "{ this is not json");
    expect(() => loadConfig(file, home)).toThrow(ConfigError);
    expect(() => loadConfig(shared(root, { peers: ["not-a-url"] }), home)).toThrow(ConfigError);
    expect(() => loadConfig(shared(root, { entry: { port: "8643" } }), home)).toThrow(ConfigError);
    // The shape of the file itself is checked the same way: a settings block
    // written at the top level would otherwise be read as no settings at all.
    writeFileSync(file, JSON.stringify({ peers: [] }));
    expect(() => loadConfig(file, home)).toThrow(ConfigError);
    writeFileSync(file, JSON.stringify({ instances: [{ dir: "relative" }] }));
    expect(() => loadConfig(file, home)).toThrow(ConfigError);
    writeFileSync(file, JSON.stringify({ instances: [{ dir: "/a" }, { dir: "/a" }] }));
    expect(() => loadShared(file)).toThrow(ConfigError);
  });

  test("the four things config carries (§8.2)", () => {
    const { root, env, home } = disposable();
    const file = shared(root, {
      peers: ["https://elsewhere.example/ccmsg/"],
      entry: { host: "127.0.0.1", port: 0, source_ips: ["127.0.0.1"] },
      upstream: { gateway_url: "https://gateway.example" },
    });
    const config = loadConfig(file, home);
    // The config home is the fourth, and it is the environment's rather than
    // the file's: an instance is the config home it was started in (A2).
    expect(resolvePaths(env).configHome).toBe(home);
    // The only URLs config carries are the peer endpoints: no origin list, and
    // no statement of which entry is this instance (§7.1, DR-0001 §2.7).
    expect(config.peers).toEqual(["https://elsewhere.example/ccmsg/"]);
    expect(config.entry?.source_ips).toEqual(["127.0.0.1"]);
    expect(config.upstream.gateway_url).toBe("https://gateway.example");
  });

  test("an instance's own entry wins over the defaults, key by key", () => {
    const { root, home } = disposable();
    const file = join(root, "config", "config.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        defaults: {
          direct_delivery: false,
          fork_origin: true,
          upstream: { gateway_url: "https://shared.example" },
        },
        instances: [
          { dir: home, direct_delivery: true },
          { dir: "/elsewhere/.claude", fork_origin: false },
        ],
      }),
    );
    const mine = loadConfig(file, home);
    // Stated in my entry: mine. Stated only in the defaults: the defaults'.
    // Stated in nobody's: the built-in.
    expect(mine.direct_delivery).toBe(true);
    expect(mine.fork_origin).toBe(true);
    expect(mine.upstream.gateway_url).toBe("https://shared.example");
    expect(mine.peers).toEqual([]);
    // The override is per instance, so the other entry keeps the default.
    expect(loadConfig(file, "/elsewhere/.claude").direct_delivery).toBe(false);
    expect(loadConfig(file, "/elsewhere/.claude").fork_origin).toBe(false);
    // A config home the file does not list is the defaults and nothing else.
    expect(loadConfig(file, "/unlisted/.claude").direct_delivery).toBe(false);
  });

  /** A settings block holding `value` at a dotted field path, and the read back
   * out of one. Written from the path so a rule can be exercised without the
   * test naming the nesting each rule happens to sit at. */
  function at(path: string, value: unknown): Record<string, unknown> {
    return path
      .split(".")
      .reduceRight<unknown>((held, name) => ({ [name]: held }), value) as Record<string, unknown>;
  }

  function read(settings: Record<string, unknown>, path: string): unknown {
    return path
      .split(".")
      .reduce<unknown>((held, name) => (held as Record<string, unknown>)[name], settings);
  }

  /** One shared file with both levels written out, read as one config home. */
  function twoLevel(
    root: string,
    defaults: Record<string, unknown>,
    instances: readonly Record<string, unknown>[],
  ): string {
    const file = join(root, "config", "config.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(file, JSON.stringify({ defaults, instances }));
    return file;
  }

  test("every declared path merges or replaces as the table says", () => {
    for (const [path, rule] of Object.entries(MERGE_RULES)) {
      // A value of the shape the rule is about: `merge` is only ever declared
      // for an object, and the rest of the table is what an array does.
      const [mine, theirs] =
        rule === "merge"
          ? [{ kept: "defaults", beaten: "defaults" }, { beaten: "instance" }]
          : [["defaults"], ["instance"]];
      const settings = settingsFor(
        {
          defaults: at(path, mine),
          instances: [{ dir: "/a/.claude", settings: at(path, theirs) }],
        },
        "/a/.claude",
      );
      expect(read(settings, path)).toEqual(
        rule === "merge" ? { kept: "defaults", beaten: "instance" } : ["instance"],
      );
    }
  });

  test("a path the table does not name replaces, whatever it holds", () => {
    const shared = {
      defaults: { harness: "claude", peers: ["https://a.example/"], upstream: { launcher: {} } },
      instances: [{ dir: "/a/.claude", settings: { harness: "codex", peers: [] } }],
    };
    const settings = settingsFor(shared, "/a/.claude");
    // A scalar is the plain case; `peers` is the array the table names replace
    // on purpose, so an instance can run with fewer peers than the defaults
    // hand out rather than only more.
    expect(settings["harness"]).toBe("codex");
    expect(settings["peers"]).toEqual([]);
  });

  test("no declared path hangs below one that replaces", () => {
    // A rule under a parent that takes its value whole would never be read:
    // the child is only reached when the parent is merged field by field.
    for (const path of Object.keys(MERGE_RULES)) {
      const cut = path.lastIndexOf(".");
      if (cut === -1) continue;
      expect(MERGE_RULES[path.slice(0, cut)]).toBe("merge");
    }
  });

  test("what an instance leaves out, an empty value, and a stated one differ", () => {
    const { root } = disposable();
    const defaults = {
      entry: { host: "10.0.0.1", port: 8643, trusted_proxies: ["10.0.0.0/8"] },
    };
    const file = twoLevel(root, defaults, [
      { dir: "/a/.claude", entry: { port: 8644 } },
      { dir: "/b/.claude", entry: { trusted_proxies: [] } },
      { dir: "/c/.claude", entry: { trusted_proxies: ["127.0.0.1/32"] } },
    ]);
    // Left out: the defaults', down to the fields the instance did not write.
    const a = loadConfig(file, "/a/.claude").entry;
    expect(a).toEqual({
      host: "10.0.0.1",
      port: 8644,
      trusted_proxies: ["10.0.0.0/8"],
      source_ips: [],
    });
    // Written empty: empty, which is how an instance trusts nobody while the
    // defaults trust somebody. No delete sentinel is needed for it.
    expect(loadConfig(file, "/b/.claude").entry?.trusted_proxies).toEqual([]);
    // Written: whole, rather than added to what the defaults hold.
    expect(loadConfig(file, "/c/.claude").entry?.trusted_proxies).toEqual(["127.0.0.1/32"]);
  });

  test("what every instance shares is written once (§8.2)", () => {
    const { root } = disposable();
    // The shape a host with several config homes ends up at: one entry and one
    // upstream in the defaults, and per instance only what actually differs.
    const file = twoLevel(
      root,
      {
        peers: ["https://one.example/ccmsg/", "https://two.example/ccmsg/"],
        entry: { host: "127.0.0.1", source_ips: ["127.0.0.1"], trusted_proxies: ["127.0.0.1/32"] },
        upstream: { terminal_gateway: "https://terminal.example" },
      },
      [
        {
          dir: "/a/.claude",
          entry: { port: 8643 },
          upstream: { gateway_url: "https://gateway.example", gateway_webhook_source: "gw" },
        },
        { dir: "/b/.claude", entry: { port: 8644 } },
        { dir: "/c/.codex", harness: "codex", entry: { port: 8645 } },
      ],
    );
    const one = loadConfig(file, "/a/.claude");
    const two = loadConfig(file, "/b/.claude");
    const three = loadConfig(file, "/c/.codex");
    // Each instance reaches the same shared values it would have got from an
    // entry that repeated them, and only the port and the gateway differ.
    for (const config of [one, two, three]) {
      expect(config.entry?.host).toBe("127.0.0.1");
      expect(config.entry?.source_ips).toEqual(["127.0.0.1"]);
      expect(config.entry?.trusted_proxies).toEqual(["127.0.0.1/32"]);
      expect(config.upstream.terminal_gateway).toBe("https://terminal.example");
      expect(config.peers).toHaveLength(2);
    }
    expect([one, two, three].map((config) => config.entry?.port)).toEqual([8643, 8644, 8645]);
    expect(one.upstream.gateway_url).toBe("https://gateway.example");
    // The one upstream an instance states does not take the shared one with
    // it: `upstream` is merged field by field.
    expect(two.upstream.gateway_url).toBeUndefined();
    expect(three.harness).toBe("codex");
    expect(one.harness).toBe("claude");
  });

  test("the launcher is merged down to its own fields", () => {
    const { root } = disposable();
    const file = twoLevel(
      root,
      {
        upstream: {
          launcher: {
            root_dirs: ["/work"],
            templates: [{ name: "shell", command: "bash" }],
            clean_env: ["CLAUDE_*"],
            depth: 3,
          },
        },
      },
      [{ dir: "/a/.claude", upstream: { launcher: { root_dirs: ["/elsewhere"] } } }],
    );
    const launcher = loadConfig(file, "/a/.claude").upstream.launcher;
    expect(launcher?.root_dirs).toEqual(["/elsewhere"]);
    expect(launcher?.templates.map((one) => one.name)).toEqual(["shell"]);
    expect(launcher?.clean_env).toEqual(["CLAUDE_*"]);
    expect(launcher?.depth).toBe(3);
  });

  test("the shared file survives a round trip through the registry's writer", () => {
    const { root, home } = disposable();
    const file = join(root, "config", "config.json");
    saveShared(file, {
      defaults: { fork_origin: true },
      instances: [{ dir: home, settings: { direct_delivery: false } }],
    });
    const read = loadShared(file);
    expect(read.defaults).toEqual({ fork_origin: true });
    expect(read.instances).toEqual([{ dir: home, settings: { direct_delivery: false } }]);
    expect(loadConfig(file, home).direct_delivery).toBe(false);
  });
});

describe("what this instance is called (DR-0001 §2.1)", () => {
  test("the id is written once and answered to across restarts", async () => {
    const { env, root } = disposable();
    const stateDir = join(root, "state");
    const first = await startAt(env);
    const id = first.self;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // On disk rather than derived, so that moving the state directory moves
    // the instance: everything it has issued is keyed by this.
    expect(readFileSync(join(stateDir, "instance.id"), "utf8").trim()).toBe(id);
    await first.stop();
    const second = await startAt(env);
    expect(second.self).toBe(id);
    await second.stop();
  });

  test("two config homes are called different things", async () => {
    const first = await startAt(disposable().env);
    const second = await startAt(disposable().env);
    expect(first.self).not.toBe(second.self);
    await first.stop();
    await second.stop();
  });
});

describe("the start order (§8.3)", () => {
  test("a broken config fails the start, and leaves no lock behind", async () => {
    const { root, env } = disposable();
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "config.json"), "{{{");
    let refused: unknown;
    try {
      await start({ env, echoLog: false });
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(ConfigError);
    // Nothing is listening, and the lock is back: correcting the file is the
    // whole of the recovery, with no leftover to clear by hand.
    expect(existsSync(resolvePaths(env).socket)).toBe(false);
    expect(existsSync(resolvePaths(env).lockFile)).toBe(false);
    writeFileSync(join(root, "config", "config.json"), JSON.stringify({ defaults: { peers: [] } }));
    const instance = await startAt(env);
    expect(instance.config.peers).toEqual([]);
  });

  test("a second start with a live holder does nothing and says who has it", async () => {
    const { env } = disposable();
    const first = await startAt(env);
    const second = await start({ env, echoLog: false });
    expect(isRunning(second)).toBe(false);
    expect(second).toEqual({ kind: "already_running", pid: process.pid });
    expect(first.socketPath).toBeTruthy();
  });

  test("a lock left by a process that is gone is taken over", async () => {
    const { env } = disposable();
    const paths = resolvePaths(env);
    mkdirSync(paths.stateDir, { recursive: true });
    // A pid that cannot be running: pid 0 is not a process one can signal, and
    // an unparseable holder is the same case.
    writeFileSync(paths.lockFile, "not a pid\n");
    const instance = await startAt(env);
    expect(readFileSync(paths.lockFile, "utf8").trim()).toBe(String(process.pid));
    expect(instance.socketPath).toBe(paths.socket);
  });

  test("twenty starters racing for one config home produce one instance", async () => {
    // The lock file has to name its holder the instant it exists. A file
    // created empty and filled afterwards has a moment where it names nobody,
    // and a starter reading it then sees a lock nobody is behind, removes it as
    // stale and takes the config home a live starter already holds.
    const { env } = disposable();
    const paths = resolvePaths(env);
    mkdirSync(paths.stateDir, { recursive: true });
    const script = join(paths.stateDir, "contend.ts");
    // Each child waits to be told to go, so all twenty contend at once rather
    // than spread over however long twenty runtimes take to start — spread out,
    // they would simply succeed one after another and the window would never be
    // entered. Having said what it got, a child holds still: a winner that
    // exited would leave a lock the others are right to take over.
    writeFileSync(
      script,
      `import { acquireLock, isHeldByUs } from ${JSON.stringify(join(import.meta.dir, "../src/instance/lock.ts"))};
console.log("ready");
process.stdin.once("data", () => {
  const outcome = acquireLock(process.argv[2]);
  console.log(isHeldByUs(outcome) ? "won" : "lost");
});
process.stdin.on("end", () => process.exit(0));
`,
    );

    const children = Array.from({ length: 20 }, () =>
      Bun.spawn(["bun", script, paths.lockFile], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
    );
    try {
      const lines = children.map((child) => lineReader(child.stdout));
      expect(await Promise.all(lines.map((read) => read()))).toEqual(Array(20).fill("ready"));
      // `write` answers with either a count or a promise of one; `flush` is
      // what actually puts it on the pipe, so neither is waited on here.
      for (const child of children) void child.stdin.write("go\n");
      for (const child of children) void child.stdin.flush();
      // Read while every child is still running, which is what keeps a winner
      // holding its lock while the others decide.
      const outcomes = await Promise.all(lines.map((read) => read()));
      expect(outcomes.filter((each) => each === "won")).toHaveLength(1);
      expect(outcomes.filter((each) => each === "lost")).toHaveLength(19);
    } finally {
      for (const child of children) child.kill();
    }
  }, 30_000);

  test("the pid file is written before anything can connect", async () => {
    const { env } = disposable();
    const paths = resolvePaths(env);
    const instance = await startAt(env);
    // Whatever a client can reach, the pid file already describes: the socket
    // exists only after `listen`, and the pid was written before it.
    expect(existsSync(paths.socket)).toBe(true);
    expect(readFileSync(paths.pidFile, "utf8").trim()).toBe(String(process.pid));
    expect(instance.ping().pid).toBe(process.pid);
    // Nothing here reaches off the host, so the instance says the link is not
    // watched rather than reporting a state it never observed.
    expect(instance.ping().network).toBe("off");
  });

  test("no upstream watch runs until something subscribes (§8.3)", async () => {
    const { env } = disposable();
    const instance = await startAt(env);
    const client = await greet(instance);
    client.send({ op: "topic_subscribe", request_id: "sub", topic: "agents" });
    expect((await client.next())["ok"]).toBe(true);
    // The snapshot that follows the acknowledgement.
    expect((await client.next())["snapshot"]).toBe(true);
  });

  test("a transcript nobody announced is found by its name and stated (§6.2)", async () => {
    // A session that is over, or one this instance never heard greet: nothing
    // announced where its transcript is, and the file carries the sid in its
    // name. The subscriber is told where the file ends, which is where a read
    // of it goes back from.
    const { env, home } = disposable();
    mkdirSync(join(home, "projects", "a-project"), { recursive: true });
    const line = `${JSON.stringify({ type: "system", subtype: "init" })}\n`;
    writeFileSync(join(home, "projects", "a-project", `${SID}.jsonl`), line);
    const instance = await startAt(env);
    const client = await greet(instance);
    client.send({ op: "topic_subscribe", request_id: "sub", topic: `transcript:${SID}` });
    expect((await client.next())["ok"]).toBe(true);
    const snapshot = await client.next();
    expect(snapshot["snapshot"]).toBe(true);
    expect(snapshot["data"]).toEqual({ sid: SID, size: Buffer.byteLength(line) });
  });
});

describe("the stop order (§8.5)", () => {
  test("the upstream watches stop before the connections are told", async () => {
    const { env } = disposable();
    const instance = await startAt(env);
    const client = await greet(instance);
    client.send({ op: "topic_subscribe", request_id: "sub", topic: "agents" });
    expect((await client.next())["ok"]).toBe(true);
    expect(instance.watching).toBe(true);
    const stopped = instance.stop();
    // Step 2 has run by the time step 3's event is on the wire.
    expect(instance.watching).toBe(false);
    await stopped;
  });

  test("the connections are told before the socket stops answering", async () => {
    const { env } = disposable();
    const instance = await startAt(env);
    const client = await greet(instance);
    const stopped = instance.stop();
    const event = await client.next();
    expect(event).toEqual({ ev: "restarting", instance: instance.self });
    await stopped;
    // Only now: a client reads a refusing socket as the instance having
    // finished leaving.
    expect(connectUds(instance.socketPath)).rejects.toThrow();
  });

  test("the pid and the lock are released before the unix socket closes", async () => {
    const { env } = disposable();
    const paths = resolvePaths(env);
    const instance = await startAt(env);
    const client = await greet(instance);
    const stopped = instance.stop();
    await client.next(); // the restarting event, which is step 3
    // Step 5 releases in order, so by the time anything about the socket has
    // changed the successor's resources are free.
    await stopped;
    expect(existsSync(paths.pidFile)).toBe(false);
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  test("a request arriving during shutdown is refused rather than half-served", async () => {
    const { env } = disposable();
    const instance = await startAt(env);
    const client = await greet(instance);
    const stopped = instance.stop();
    // Asked of the door every request comes through, rather than over a
    // socket that is being taken down while the frame is in flight: the guard
    // is what this fixes, and racing the teardown would test the race.
    const refusal = await instance.handle(
      { op: "instance_ping", request_id: "late" },
      {
        identity: { state: "settled", role: "user" },
        send() {},
        deferSend() {},
        onClose() {},
        close() {},
      },
    );
    expect(refusal.kind).toBe("error");
    await stopped;
    await client.close();
  });

  test("stopping twice runs the order once", async () => {
    const { env } = disposable();
    const instance = await startAt(env);
    await Promise.all([instance.stop(), instance.stop()]);
    await instance.whenStopped();
  });
});

describe("what a run leaves behind (M4)", () => {
  /** The ops that write something, run once each.
   *
   * A run that answers nothing writes nothing, so listing the state directory
   * after it would say only that an idle daemon is tidy. These are the three
   * that put bytes somewhere on purpose — a value a person saved, a dump a
   * session asked for, and a file into a session's own working directory — and
   * M4 is the question of which of them lands in the state directory. */
  async function writeThroughEveryOp(instance: Instance, run: string): Promise<void> {
    const client = await greet(instance);
    client.send({ op: "kv_write", request_id: `kv-${run}`, ns: "test", key: "theme", value: run });
    expect((await client.next())["ok"]).toBe(true);
    client.send({ op: "session_dump_write", request_id: `dump-${run}`, sid: SID });
    expect((await client.next())["ok"]).toBe(true);
    // Its destination is the session's working directory, which is nowhere
    // near the state directory — that it stays out of the listing below is the
    // point of running it here.
    client.send({
      op: "file_write",
      request_id: `file-${run}`,
      sid: SID,
      path: `docs/inbox/${run}.md`,
      content: "a note\n",
    });
    expect((await client.next())["ok"]).toBe(true);
  }

  test("start, stop, start again adds only the persisted kinds and the handles", async () => {
    const { env, root, home } = disposable();
    const paths = resolvePaths(env);
    // A session for those ops to be about: the harness row is what says it
    // exists and where it works, and the transcript is what a dump is of.
    const cwd = join(root, "work");
    mkdirSync(join(home, "projects", "a"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, "projects", "a", `${SID}.jsonl`), "");
    writeFileSync(
      join(home, "sessions", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: SID,
        cwd,
        kind: "interactive",
        startedAt: 1_757_000_000_000,
      }),
    );

    const first = await startAt(env);
    await writeThroughEveryOp(first, "one");
    await first.stop();
    const afterFirst = new Set(readdirSync(paths.stateDir));
    const second = await startAt(env);
    await writeThroughEveryOp(second, "two");
    await second.stop();
    const afterSecond = readdirSync(paths.stateDir);
    for (const name of afterSecond) {
      if (afterFirst.has(name)) continue;
      throw new Error(`the second run added ${name}`);
    }
    // The five of §3.6, the dumps a caller asked for, and the handles —
    // nothing that is a derived value written down.
    const allowed = new Set([
      "instance.id",
      "last-live.json",
      "daemon.log",
      "inbox.jsonl",
      KV_DIR,
      DUMPS,
      "daemon.pid",
      "daemon.sock",
      "daemon.lock",
    ]);
    for (const name of afterSecond) {
      expect(allowed.has(name) || REAL_SOCKET.test(name)).toBe(true);
    }
    // Each op wrote where it said it would, so the listing above is a statement
    // about ops that ran rather than about ops that quietly refused.
    expect(existsSync(join(paths.stateDir, KV_DIR))).toBe(true);
    expect(readdirSync(join(paths.stateDir, DUMPS)).length).toBe(2);
    expect(existsSync(join(cwd, "docs", "inbox", "one.md"))).toBe(true);
  });
});

describe("only this config home is read (M6)", () => {
  test("another config home beside it is never opened", async () => {
    const { root, env, home } = disposable();
    // A second config home, with a session in it that would show up in
    // `agents` if anything went looking.
    const other = join(root, "other-home", "sessions");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "1.json"),
      JSON.stringify({ sessionId: "11111111-1111-1111-1111-111111111111", cwd: "/elsewhere" }),
    );
    const instance = await startAt(env);
    const client = await greet(instance);
    client.send({ op: "topic_subscribe", request_id: "sub", topic: "agents" });
    expect((await client.next())["ok"]).toBe(true);
    const snapshot = await client.next();
    expect(snapshot["data"]).toEqual({ agents: [] });
    expect(instance.paths.configHome).toBe(home);
  });
});

describe("the ops the instance answers", () => {
  test("an op the contract defines and this instance does not implement says so", () => {
    // Every op in the table now has an implementation, so the filler is asked
    // for directly: it is what an op added to the contract reaches before
    // anything is written for it, and dispatch finding no handler at all is
    // what it exists to prevent (M1).
    const handlers = completeHandlers({});
    expect(Object.keys(handlers).sort()).toEqual([...OP_NAMES].sort());
    let refused: unknown;
    try {
      handlers["kv_read"]({} as never);
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(OpError);
    expect((refused as OpError).code).toBe("not_found");
    expect((refused as OpError).message).toContain("not implemented");
  });

  test("instance_shutdown is answered before the instance goes", async () => {
    const { env } = disposable();
    const instance = await startAt(env);
    const client = await greet(instance);
    client.send({ op: "instance_shutdown", request_id: "bye" });
    const answer = await client.next();
    expect(answer).toEqual({ ok: true, request_id: "bye" });
    await instance.whenStopped();
  });
});

describe("the stable address across a succession", () => {
  test("a successor takes the address, and the predecessor's own path goes with it", async () => {
    const { env } = disposable();
    const paths = resolvePaths(env);
    // The predecessor is a separate process, because the pid is what tells the
    // two real paths apart and this process only has one.
    const first = Bun.spawn(["bun", CLI, "daemon", "run"], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await started(first);
      const predecessor = join(paths.socketDir, realSocketName(first.pid));
      expect(existsSync(predecessor)).toBe(true);
      expect(readlinkSync(paths.socket)).toBe(realSocketName(first.pid));

      // Only one instance holds a config home at a time (§8.3 step 2), so the
      // successor starts once the predecessor has gone.
      await stopViaSocket(paths.socket);
      expect(await first.exited).toBe(0);
      expect(existsSync(predecessor)).toBe(false);

      const second = await startAt(env);
      expect(readlinkSync(paths.socket)).toBe(realSocketName(process.pid));
      // The address a client held before the succession still reaches the
      // instance, without the client knowing a different process answers.
      const client = await connectUds(paths.socket);
      clients.push(client);
      client.send({ op: "instance_ping", request_id: "ping" });
      expect((await client.next())["pid"]).toBe(second.ping().pid);
    } finally {
      first.kill();
    }
  }, 20_000);

  test("a real socket left by a process that is gone is swept on the next start", async () => {
    const { env } = disposable();
    const paths = resolvePaths(env);
    mkdirSync(paths.socketDir, { recursive: true });
    // A path named after a pid nobody is running, as a killed instance would
    // leave it. `1` would be init; a pid this large is free on both platforms.
    const orphan = join(paths.socketDir, realSocketName(4_194_303));
    writeFileSync(orphan, "");
    await startAt(env);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("a daemon in its own process", () => {
  test("run, greet it over the unix socket, shut it down, and it exits", async () => {
    const { env } = disposable();
    const paths = resolvePaths(env);
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "daemon", "run"],
      {
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await started(child);
      const client = await connectUds(paths.socket);
      clients.push(client);
      client.send({
        op: "hello",
        request_id: "hello",
        role: "user",
        protocol_version: PROTOCOL_VERSION,
      });
      const greeting = await client.next();
      expect(greeting["ok"]).toBe(true);
      expect(greeting["protocol_version"]).toBe(PROTOCOL_VERSION);
      client.send({ op: "topic_subscribe", request_id: "sub", topic: "peers" });
      expect((await client.next())["ok"]).toBe(true);
      expect((await client.next())["snapshot"]).toBe(true);

      client.send({ op: "instance_shutdown", request_id: "bye" });
      expect(await replyTo(client, "bye")).toEqual({ ok: true, request_id: "bye" });
      expect(await child.exited).toBe(0);
    } finally {
      child.kill();
    }
  }, 20_000);
});

/** Ask an instance to leave, the way the CLI does. */
async function stopViaSocket(address: string): Promise<void> {
  const client = await connectUds(address);
  client.send({
    op: "hello",
    request_id: "hello",
    role: "user",
    protocol_version: PROTOCOL_VERSION,
  });
  await client.next();
  client.send({ op: "instance_shutdown", request_id: "bye" });
  await replyTo(client, "bye");
  await client.close();
}

/** The reply to one request, skipping the topic frames and connection events
 * that arrive on the same connection while it is in flight. */
async function replyTo(client: LineClient, requestId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = await client.next();
    if (frame["request_id"] === requestId) return frame;
  }
}

/** Reads one line at a time off a stream, without waiting for it to end —
 * which a process that is deliberately still running will not do. Undefined
 * once the stream is over and there is nothing held back. */
function lineReader(stream: ReadableStream<Uint8Array>): () => Promise<string | undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let held = "";
  return async () => {
    for (;;) {
      const newline = held.indexOf("\n");
      if (newline >= 0) {
        const line = held.slice(0, newline);
        held = held.slice(newline + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (value !== undefined) held += decoder.decode(value, { stream: true });
      if (done) {
        const rest = held;
        held = "";
        return rest === "" ? undefined : rest;
      }
    }
  };
}

/** Wait for a daemon in another process to say it is up.
 *
 * The last step of §8.3 is the `started` line the instance writes to its log
 * and mirrors to stderr, so the event itself is what is waited on. A child that
 * exits instead ends the wait there, rather than leaving the case to run out
 * its timeout on a socket that is never going to appear. */
async function started(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  const read = lineReader(child.stderr);
  const up = (async () => {
    for (;;) {
      const line = await read();
      if (line === undefined) return false;
      let event: { message?: unknown };
      try {
        event = JSON.parse(line) as { message?: unknown };
      } catch {
        continue;
      }
      if (event.message === "started") return true;
    }
  })();
  if (await Promise.race([up, child.exited.then(() => false)])) return;
  throw new Error(`the daemon exited with ${await child.exited} instead of starting`);
}
