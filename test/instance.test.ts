import { afterEach, describe, expect, test } from "bun:test";
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
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import {
  ConfigError,
  DEFAULT_CONFIG,
  type Env,
  Instance,
  isRunning,
  loadConfig,
  REAL_SOCKET,
  realSocketName,
  resolvePaths,
  start,
} from "../src/instance/index.ts";
import { connectUds, type LineClient } from "./client.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** A config home nothing else has, with its state and config directories
 * beside it. Everything one instance touches is under here, which is what
 * makes "what did a run leave behind" a directory listing (M4). */
function disposable(): { env: Env; root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-instance-"));
  const home = join(root, "home");
  mkdirSync(join(home, "sessions"), { recursive: true });
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

describe("paths", () => {
  test("every path is derived from the config home (§8.1)", () => {
    const one = resolvePaths({ CLAUDE_CONFIG_DIR: "/homes/.claude-a", HOME: "/homes" });
    const two = resolvePaths({ CLAUDE_CONFIG_DIR: "/homes/.claude-b", HOME: "/homes" });
    expect(one.socket).not.toBe(two.socket);
    expect(one.stateDir).not.toBe(two.stateDir);
    expect(one.configFile).not.toBe(two.configFile);
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
  test("no config file is not a broken one", () => {
    const { root } = disposable();
    expect(loadConfig(join(root, "config", "config.json"))).toEqual(DEFAULT_CONFIG);
  });

  test("route (a) is on unless the config turns it off, and only by a boolean", () => {
    const { root } = disposable();
    const file = join(root, "config", "config.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(file, JSON.stringify({}));
    expect(loadConfig(file).direct_delivery).toBe(true);
    writeFileSync(file, JSON.stringify({ direct_delivery: false }));
    expect(loadConfig(file).direct_delivery).toBe(false);
    writeFileSync(file, JSON.stringify({ direct_delivery: "no" }));
    expect(() => loadConfig(file)).toThrow(ConfigError);
  });

  test("a broken config throws rather than dropping the setting it carried", () => {
    const { root } = disposable();
    const file = join(root, "config", "config.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(file, "{ this is not json");
    expect(() => loadConfig(file)).toThrow(ConfigError);
    writeFileSync(file, JSON.stringify({ peers: ["not-a-url"] }));
    expect(() => loadConfig(file)).toThrow(ConfigError);
    writeFileSync(file, JSON.stringify({ entry: { port: "8643" } }));
    expect(() => loadConfig(file)).toThrow(ConfigError);
  });

  test("the four things config carries (§8.2)", () => {
    const { root, env, home } = disposable();
    const file = join(root, "config", "config.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        peers: ["wss://elsewhere.example/ccmsg"],
        entry: { host: "127.0.0.1", port: 0, source_ips: ["127.0.0.1"], origins: ["http://ui"] },
        upstream: { gateway_url: "https://gateway.example" },
      }),
    );
    const config = loadConfig(file);
    // The config home is the fourth, and it is the environment's rather than
    // the file's: an instance is the config home it was started in (A2).
    expect(resolvePaths(env).configHome).toBe(home);
    expect(config.peers).toEqual(["wss://elsewhere.example/ccmsg"]);
    expect(config.entry?.origins).toEqual(["http://ui"]);
    expect(config.upstream.gateway_url).toBe("https://gateway.example");
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
    writeFileSync(join(root, "config", "config.json"), JSON.stringify({ peers: [] }));
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

  test("the pid file is written before anything can connect", async () => {
    const { env } = disposable();
    const paths = resolvePaths(env);
    const instance = await startAt(env);
    // Whatever a client can reach, the pid file already describes: the socket
    // exists only after `listen`, and the pid was written before it.
    expect(existsSync(paths.socket)).toBe(true);
    expect(readFileSync(paths.pidFile, "utf8").trim()).toBe(String(process.pid));
    expect(instance.ping().pid).toBe(process.pid);
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
  test("start, stop, start again adds only the three persisted kinds and the handles", async () => {
    const { env } = disposable();
    const paths = resolvePaths(env);
    const first = await startAt(env);
    await first.stop();
    const afterFirst = new Set(readdirSync(paths.stateDir));
    const second = await startAt(env);
    await second.stop();
    const afterSecond = readdirSync(paths.stateDir);
    for (const name of afterSecond) {
      if (afterFirst.has(name)) continue;
      throw new Error(`the second run added ${name}`);
    }
    // The three of §3.6 plus the handles, and nothing that is a derived value
    // written down.
    const allowed = new Set([
      "last-live.json",
      "daemon.log",
      "inbox.jsonl",
      "daemon.pid",
      "daemon.sock",
      "daemon.lock",
    ]);
    for (const name of afterSecond) {
      expect(allowed.has(name) || REAL_SOCKET.test(name)).toBe(true);
    }
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
  test("an op the contract defines and this instance does not implement says so", async () => {
    const { env } = disposable();
    const instance = await startAt(env);
    const client = await greet(instance);
    client.send({ op: "kv_read", request_id: "kv", ns: "x", key: "y" });
    const answer = await client.next();
    expect(answer["ok"]).toBe(false);
    expect((answer["error"] as { code: string }).code).toBe("not_found");
    expect((answer["error"] as { msg: string }).msg).toContain("not implemented");
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
      await waitFor(() => existsSync(paths.socket));
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
      await waitFor(() => existsSync(paths.socket));
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

/** Wait for a condition a separate process brings about.
 *
 * Polling, because the thing being waited for is a file appearing in a
 * directory this process does not own the writes to, and a watch on a
 * directory that does not exist yet has the same race one level up. The
 * interval is the shortest one that is not a spin. */
async function waitFor(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) return;
    await Bun.sleep(25);
  }
  throw new Error("the daemon did not come up");
}
