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
  CONFIG_FILE,
  ConfigError,
  DEFAULT_CONFIG,
  type Env,
  Instance,
  isRunning,
  loadAll,
  loadClusters,
  loadConfig,
  loadInstances,
  saveCluster,
  saveClusters,
  REAL_SOCKET,
  realSocketName,
  resolvePaths,
  start,
} from "../src/instance/index.ts";
import type {
  Config as Draft,
  InstanceConfig as InstanceDraft,
} from "../src/instance/ccmsg-config";
import type {
  DumpConfig,
  EntryConfig,
  InstanceConfig,
  LauncherConfig,
  UpstreamConfig,
} from "../src/instance/config.ts";
import { connectUds, type LineClient } from "./client.ts";
import { SID } from "./frames.ts";
import { reapOrphans, trackRoot, writeConfigHome } from "./harness.ts";

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
    op: "hello.user",
    request_id: "hello",
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
  /** A config home whose shared file states one flat block of settings. Every
   * instance starts from what that file returns, which is what makes this the
   * short way to write "an instance configured like so". */
  function shared(root: string, defaults: Record<string, unknown> | string): string {
    return join(writeConfigHome(join(root, "config"), defaults), "..");
  }

  test("no config file is not a broken one", async () => {
    const { root, home } = disposable();
    expect(await loadConfig(join(root, "config"), home)).toEqual(DEFAULT_CONFIG);
  });

  test("route (a) is on unless the config turns it off, and only by a boolean", async () => {
    const { root, home } = disposable();
    expect((await loadConfig(shared(root, {}), home)).direct_delivery).toBe(true);
    expect((await loadConfig(shared(root, { direct_delivery: false }), home)).direct_delivery).toBe(
      false,
    );
    const wrong = shared(root, { direct_delivery: "no" });
    expect(loadConfig(wrong, home)).rejects.toThrow(ConfigError);
  });

  test("a config file that cannot be read ends the read rather than dropping what it carried", async () => {
    const { root, home } = disposable();
    const dir = join(root, "config");
    // Nothing to call: a file that states no function states no settings, and
    // reading it as none would turn every setting it was meant to carry off.
    expect(loadConfig(shared(root, "export const settings = {};\n"), home)).rejects.toThrow(
      ConfigError,
    );
    // A file that throws is the operator's mistake, reported where they made it.
    expect(
      loadConfig(shared(root, "export default () => { throw new Error('nope'); };\n"), home),
    ).rejects.toThrow(ConfigError);
    // A field nobody has: the types say so while it is being written, and this
    // says so when it is read, because a misspelled field is a setting that was
    // written and does not take.
    expect(loadConfig(shared(root, { direct_deliver: false }), home)).rejects.toThrow(/unknown/);
    // The values themselves are held to the same shapes as before.
    expect(loadConfig(shared(root, { peers: ["not-a-url"] }), home)).rejects.toThrow(ConfigError);
    expect(loadConfig(shared(root, { entry: { port: "8643" } }), home)).rejects.toThrow(
      ConfigError,
    );
    // `dir` is what an instance file names, so the shared file naming one is a
    // file written in the wrong place.
    expect(loadConfig(shared(root, { dir: home }), home)).rejects.toThrow(/dir/);
    // And an instance file that names none, or names a relative one, is an
    // instance nothing can answer for.
    writeConfigHome(dir, {}, { one: {} });
    expect(loadConfig(dir, home)).rejects.toThrow(/dir/);
    writeConfigHome(dir, {}, { one: { dir: "relative" } });
    expect(loadConfig(dir, home)).rejects.toThrow(/dir/);
    // Two files answering for one config home would take each other's lock.
    writeConfigHome(dir, {}, { one: { dir: home }, two: { dir: home } });
    expect(loadConfig(dir, home)).rejects.toThrow(/already/);
  });

  test("settings that are still JSON say where they have moved to", async () => {
    const { root, home } = disposable();
    const dir = join(root, "config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ defaults: {}, instances: [] }));
    expect(loadConfig(dir, home)).rejects.toThrow(CONFIG_FILE);
  });

  test("the four things config carries (§8.2)", async () => {
    const { root, env, home } = disposable();
    const dir = join(root, "config");
    writeConfigHome(
      dir,
      {},
      {
        mine: {
          dir: home,
          entry: { host: "127.0.0.1", port: 0, source_ips: ["127.0.0.1"] },
          upstream: { gateway_url: "https://gateway.example" },
        },
      },
      ["https://elsewhere.example/ccmsg/"],
    );
    const config = await loadConfig(dir, home);
    // The config home is the fourth, and it is the environment's rather than
    // the file's: an instance is the config home it was started in (A2).
    expect(resolvePaths(env).configHome).toBe(home);
    // The only URLs config carries are the peer endpoints: no origin list, and
    // no statement of which entry is this instance (§7.1, DR-0001 §2.7).
    // Its own address, then the one its cluster was told of.
    expect(config.peers).toEqual([
      `http://127.0.0.1:${String(config.entry?.port ?? 0)}/`,
      "https://elsewhere.example/ccmsg/",
    ]);
    expect(config.entry?.source_ips).toEqual(["127.0.0.1"]);
    expect(config.upstream.gateway_url).toBe("https://gateway.example");
  });

  test("an instance behind a proxy is in the mesh under the name its peers dial", async () => {
    const { root } = disposable();
    const dir = join(root, "config");
    const entry = { host: "127.0.0.1", source_ips: [], trusted_proxies: [] };
    writeConfigHome(
      dir,
      {},
      {
        // The address it binds and the address it is reached at are two facts,
        // and neither follows from the other: what goes in the mesh is the one
        // a peer can dial, which is also what the probe settles `self` to and
        // what a handshake carries (§7.1).
        front: {
          dir: "/a/.claude",
          endpoint: "https://ccmsg-front.example/",
          entry: { ...entry, port: 8643 },
        },
        plain: { dir: "/b/.claude", entry: { ...entry, port: 8644 } },
      },
    );
    const { instances } = await loadAll(dir);
    for (const instance of instances) {
      expect(instance.config.peers).toEqual([
        "https://ccmsg-front.example/",
        "http://127.0.0.1:8644/",
      ]);
    }
    // And it is the instance's own to state: the shared file cannot say one
    // address for every instance of the host.
    expect(loadConfig(dir, "/a/.claude")).resolves.toMatchObject({
      endpoint: "https://ccmsg-front.example/",
    });
    writeConfigHome(dir, { endpoint: "https://ccmsg-front.example/" });
    expect(loadConfig(dir, "/a/.claude")).rejects.toThrow(/endpoint belongs to an instances/);
  });

  test("the mesh is the instances of a cluster, and then what it was told of", async () => {
    const { root } = disposable();
    const dir = join(root, "config");
    const entry = { host: "127.0.0.1", source_ips: [], trusted_proxies: [] };
    writeConfigHome(
      dir,
      {},
      {
        one: { dir: "/a/.claude", entry: { ...entry, port: 8643 } },
        two: { dir: "/b/.claude", entry: { ...entry, port: 8644 } },
        // An instance with no entry serves the unix socket alone, so there is
        // no address for a peer to dial and it is in nobody's list.
        three: { dir: "/c/.claude" },
      },
      [
        "https://far.example/ccmsg/",
        // The address of an instance of this host, written by hand: taken once,
        // because a list naming this instance twice would end its start (§7.1).
        "http://127.0.0.1:8643/",
      ],
    );

    const { instances } = await loadAll(dir);
    // The same list for every instance, its own address among them, local
    // first: what a person reads opens with what this host is.
    for (const instance of instances) {
      expect(instance.config.peers).toEqual([
        "http://127.0.0.1:8643/",
        "http://127.0.0.1:8644/",
        "https://far.example/ccmsg/",
      ]);
    }
  });

  test("a mesh stated in TypeScript says where a mesh is stated", async () => {
    const { root, home } = disposable();
    // Not "unknown field": a person writing this is not misspelling anything,
    // so what they are told is where the thing they meant lives now.
    expect(loadConfig(shared(root, { peers: [] }), home)).rejects.toThrow(
      /a mesh belongs to a cluster/,
    );
  });

  test("what a cluster holds is endpoints and ids, and each of them once", async () => {
    const { root, home } = disposable();
    const dir = join(root, "config");
    writeConfigHome(dir, {});
    const id = loadClusters(dir)[0]?.id as string;
    const file = join(dir, "clusters", `cluster-${id}.json`);
    writeFileSync(file, JSON.stringify({ peers: {} }));
    expect(loadConfig(dir, home)).rejects.toThrow(/array of endpoint/);
    writeFileSync(file, JSON.stringify({ peers: ["not-a-url"] }));
    expect(loadConfig(dir, home)).rejects.toThrow(ConfigError);
    writeFileSync(file, "{ this is not json");
    expect(loadConfig(dir, home)).rejects.toThrow(/JSON/);
    writeFileSync(
      file,
      JSON.stringify({ peers: ["https://one.example/", "https://one.example/"] }),
    );
    expect(loadConfig(dir, home)).rejects.toThrow(/repeats/);
    writeFileSync(file, JSON.stringify({ instances: ["not-an-id"] }));
    expect(loadConfig(dir, home)).rejects.toThrow(/array of instance ids/);
  });

  test("what is read is what the files list, and what they list has to be there", async () => {
    const { root, home } = disposable();
    const dir = join(root, "config");
    writeConfigHome(dir, {}, { one: { dir: home } });
    // A file nobody listed is not an instance: what runs is stated, so a copy
    // of a settings file kept beside it starts nothing.
    writeFileSync(
      join(dir, "instances", "instance-" + "f".repeat(32) + ".ts"),
      "export default ({ config }: any) => { config.dir = '/stray/.claude'; return config; };\n",
    );
    expect((await loadInstances(dir)).map((one) => one.dir)).toEqual([home]);
    // And an id listed with no file is an error rather than a cluster that
    // quietly shrank.
    const cluster = loadClusters(dir)[0] as {
      id: string;
      name: string;
      peers: never[];
      instances: string[];
    };
    saveCluster(dir, { ...cluster, instances: [...cluster.instances, "a".repeat(32)] });
    expect(loadConfig(dir, home)).rejects.toThrow(/is not there/);
    // A cluster listed with no file of its own, likewise.
    saveClusters(dir, [cluster.id, "b".repeat(32)]);
    expect(loadConfig(dir, home)).rejects.toThrow(/is not there/);
  });

  test("an instance's own file builds on what the shared one returned", async () => {
    const { root, home } = disposable();
    const dir = join(root, "config");
    writeConfigHome(
      dir,
      {
        direct_delivery: false,
        fork_origin: true,
        upstream: { gateway_url: "https://shared.example" },
      },
      {
        mine: { dir: home, direct_delivery: true },
        other: { dir: "/elsewhere/.claude", fork_origin: false },
      },
    );
    const mine = await loadConfig(dir, home);
    // Stated in my file: mine. Stated only in the shared one: the shared one's.
    // Stated in neither: the built-in.
    expect(mine.direct_delivery).toBe(true);
    expect(mine.fork_origin).toBe(true);
    expect(mine.upstream.gateway_url).toBe("https://shared.example");
    expect(mine.peers).toEqual([]);
    // What one instance writes is that instance's, so the other keeps what the
    // shared file handed it.
    expect((await loadConfig(dir, "/elsewhere/.claude")).direct_delivery).toBe(false);
    expect((await loadConfig(dir, "/elsewhere/.claude")).fork_origin).toBe(false);
    // A config home no file names is the shared file's answer and nothing else.
    expect((await loadConfig(dir, "/unlisted/.claude")).direct_delivery).toBe(false);
  });

  test("what a file is handed to build on cannot be written to", async () => {
    const { root, home } = disposable();
    const dir = join(root, "config");
    // The deep freeze is what makes "state your difference" a thing a file can
    // be written against: `builtin` and `default` are settled before it runs,
    // so a file that edited one would be editing what another file reads.
    writeConfigHome(
      dir,
      "export default ({ builtin }: any) => { builtin.dump.presets.push(1); };\n",
    );
    expect(loadConfig(dir, home)).rejects.toThrow(ConfigError);
    writeConfigHome(
      dir,
      { fork_origin: true },
      {
        mine: `export default ({ default: shared, config }: any) => {
          shared.dump.presets.push({ name: "no" });
          return config;
        };\n`,
      },
    );
    expect(loadConfig(dir, home)).rejects.toThrow(ConfigError);
    // The copy it edits is its own: what one file writes onto it is not what
    // the next file is handed.
    writeConfigHome(
      dir,
      { upstream: { gateway_url: "https://shared.example" } },
      {
        mine: `export default ({ config }: any) => {
          config.dir = ${JSON.stringify(home)};
          config.upstream.gateway_webhook_source = "mine";
          return config;
        };\n`,
        other: `export default ({ config }: any) => {
          config.dir = "/elsewhere/.claude";
          return config;
        };\n`,
      },
    );
    expect((await loadConfig(dir, home)).upstream.gateway_webhook_source).toBe("mine");
    expect(
      (await loadConfig(dir, "/elsewhere/.claude")).upstream.gateway_webhook_source,
    ).toBeUndefined();
  });

  test("an async config file is read the same way", async () => {
    const { root, home } = disposable();
    const dir = join(root, "config");
    // What a file has to do to answer — read a secret, ask something — is its
    // business, so the answer is awaited rather than required to be at hand.
    writeConfigHome(
      dir,
      `export default async ({ config }: any) => {
      await Promise.resolve();
      config.fork_origin = true;
      return config;
    };\n`,
    );
    expect((await loadConfig(dir, home)).fork_origin).toBe(true);
  });

  test("what an instance leaves out, an empty value, and a stated one differ", async () => {
    const { root } = disposable();
    const dir = join(root, "config");
    const entry = { host: "10.0.0.1", port: 8643, trusted_proxies: ["10.0.0.0/8"] };
    writeConfigHome(
      dir,
      { entry },
      {
        a: { dir: "/a/.claude", entry: { ...entry, port: 8644 } },
        b: { dir: "/b/.claude", entry: { ...entry, trusted_proxies: [] } },
        c: { dir: "/c/.claude", entry: { ...entry, trusted_proxies: ["127.0.0.1/32"] } },
      },
    );
    // Left out: what the shared file returned, down to the fields this one did
    // not touch — the copy it edits already holds them.
    expect((await loadConfig(dir, "/a/.claude")).entry).toEqual({
      host: "10.0.0.1",
      port: 8644,
      trusted_proxies: ["10.0.0.0/8"],
      source_ips: [],
    });
    // Written empty: empty, which is how an instance trusts nobody while the
    // shared file trusts somebody. No delete sentinel is needed for it.
    expect((await loadConfig(dir, "/b/.claude")).entry?.trusted_proxies).toEqual([]);
    expect((await loadConfig(dir, "/c/.claude")).entry?.trusted_proxies).toEqual(["127.0.0.1/32"]);
  });

  test("what every instance shares is written once (§8.2)", async () => {
    const { root } = disposable();
    const dir = join(root, "config");
    // The shape a host with several config homes ends up at: one entry and one
    // upstream in the shared file, and per instance only what actually differs.
    const entry = {
      host: "127.0.0.1",
      source_ips: ["127.0.0.1"],
      trusted_proxies: ["127.0.0.1/32"],
      port: 0,
    };
    writeConfigHome(
      dir,
      {
        entry,
        upstream: { terminal_gateway: "https://terminal.example" },
      },
      {
        a: `export default ({ config }: any) => {
          config.dir = "/a/.claude";
          config.entry.port = 8643;
          config.upstream.gateway_url = "https://gateway.example";
          config.upstream.gateway_webhook_source = "gw";
          return config;
        };\n`,
        b: `export default ({ config }: any) => {
          config.dir = "/b/.claude";
          config.entry.port = 8644;
          return config;
        };\n`,
        c: `export default ({ config }: any) => {
          config.dir = "/c/.codex";
          config.harness = "codex";
          config.entry.port = 8645;
          return config;
        };\n`,
      },
    );
    const one = await loadConfig(dir, "/a/.claude");
    const two = await loadConfig(dir, "/b/.claude");
    const three = await loadConfig(dir, "/c/.codex");
    // Each instance reaches the same shared values it would have got from a
    // file that repeated them, and only the port and the gateway differ.
    for (const config of [one, two, three]) {
      expect(config.entry?.host).toBe("127.0.0.1");
      expect(config.entry?.source_ips).toEqual(["127.0.0.1"]);
      expect(config.entry?.trusted_proxies).toEqual(["127.0.0.1/32"]);
      expect(config.upstream.terminal_gateway).toBe("https://terminal.example");
      // Three instances of one host are three entries of one mesh, each of
      // them written by nobody.
      expect(config.peers).toHaveLength(3);
    }
    expect([one, two, three].map((config) => config.entry?.port)).toEqual([8643, 8644, 8645]);
    expect(one.upstream.gateway_url).toBe("https://gateway.example");
    // What one instance wrote is that instance's: the field it set beside the
    // shared ones is not one the next instance has.
    expect(two.upstream.gateway_url).toBeUndefined();
    expect(three.harness).toBe("codex");
    expect(one.harness).toBe("claude");
  });

  test("the launcher is a form the instance edits field by field", async () => {
    const { root } = disposable();
    const dir = join(root, "config");
    writeConfigHome(
      dir,
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
      {
        a: `export default ({ config }: any) => {
          config.dir = "/a/.claude";
          config.upstream.launcher.root_dirs = ["/elsewhere"];
          return config;
        };\n`,
      },
    );
    const launcher = (await loadConfig(dir, "/a/.claude")).upstream.launcher;
    expect(launcher?.root_dirs).toEqual(["/elsewhere"]);
    expect(launcher?.templates.map((one) => one.name)).toEqual(["shell"]);
    expect(launcher?.clean_env).toEqual(["CLAUDE_*"]);
    expect(launcher?.depth).toBe(3);
  });

  test("a file edited between two reads is read again", async () => {
    const { root, home } = disposable();
    const dir = join(root, "config");
    writeConfigHome(dir, { fork_origin: false });
    expect((await loadConfig(dir, home)).fork_origin).toBe(false);
    // An import is cached by its specifier, so a process that reads a config
    // home twice — a supervisor told to add an instance — would otherwise be
    // reading the first version of a file somebody has since edited.
    await Bun.sleep(10);
    writeConfigHome(dir, { fork_origin: true });
    expect((await loadConfig(dir, home)).fork_origin).toBe(true);
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
    writeConfigHome(
      join(root, "config"),
      "export default ({ config }: any) => { config.peers = ['nope']; return config; };\n",
    );
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
    writeConfigHome(join(root, "config"), {});
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
    client.send({ op: "topic.subscribe", request_id: "sub", topic: "agents" });
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
    client.send({ op: "topic.subscribe", request_id: "sub", topic: `transcript:${SID}` });
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
    client.send({ op: "topic.subscribe", request_id: "sub", topic: "agents" });
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
      { op: "instance.ping", request_id: "late" },
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
    client.send({ op: "kv.write", request_id: `kv-${run}`, ns: "test", key: "theme", value: run });
    expect((await client.next())["ok"]).toBe(true);
    client.send({ op: "session.dump.write", request_id: `dump-${run}`, sid: SID });
    expect((await client.next())["ok"]).toBe(true);
    // Its destination is the session's working directory, which is nowhere
    // near the state directory — that it stays out of the listing below is the
    // point of running it here.
    client.send({
      op: "file.write",
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
    client.send({ op: "topic.subscribe", request_id: "sub", topic: "agents" });
    expect((await client.next())["ok"]).toBe(true);
    const snapshot = await client.next();
    // The rows are the whole of what the other config home would have shown,
    // and there are none; `polled_at` says when the read behind them ran.
    expect((snapshot["data"] as { agents: unknown[] }).agents).toEqual([]);
    expect(instance.paths.configHome).toBe(home);
  });
});

describe("a session that never greeted this instance", () => {
  /** What a restart is left with, and nothing else: the harness's state file,
   * the key beside it, and a socket at the path that file names.
   *
   * Nothing here greets. A session greets when it starts, and a daemon that
   * came up afterwards is one no session on the host has ever spoken to — so
   * this is the whole of what the instance has to work from, and both what it
   * says about the session and how it reaches it have to come out of it. */
  function unGreeted(home: string, sid: string): { lines: string[]; stop: () => void } {
    // Short by construction: the path has to fit in `sun_path`, and a
    // temporary directory plus a name is already most of it.
    const socketDir = mkdtempSync(join(tmpdir(), "ccs-"));
    trackRoot(socketDir);
    const socketPath = join(socketDir, `${process.pid}.sock`);
    writeFileSync(
      join(home, "sessions", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: sid,
        cwd: "/repos/a-repo/main",
        kind: "interactive",
        startedAt: 1_757_000_000_000,
        name: "a-repo@main",
        messagingSocketPath: socketPath,
        peerProtocol: 1,
      }),
    );
    writeFileSync(
      join(home, "sessions", `${process.pid}.${"ab".repeat(32)}.key`),
      JSON.stringify({ peerToken: "0123456789abcdef0123456789abcdef" }),
      { mode: 0o600 },
    );
    const lines: string[] = [];
    let held = "";
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data: (_socket, chunk) => {
          held += chunk.toString();
          let at: number;
          while ((at = held.indexOf("\n")) >= 0) {
            lines.push(held.slice(0, at));
            held = held.slice(at + 1);
          }
        },
        open: () => {},
        close: () => {},
        error: () => {},
      },
    });
    return { lines, stop: () => server.stop(true) };
  }

  async function peersOf(instance: Instance): Promise<Record<string, unknown>[]> {
    const client = await greet(instance);
    client.send({ op: "topic.subscribe", request_id: "sub", topic: "peers" });
    expect((await client.next())["ok"]).toBe(true);
    const snapshot = await client.next();
    return (snapshot["data"] as { peers: Record<string, unknown>[] }).peers;
  }

  test("is on `peers` as live, before and after a restart", async () => {
    const { env, home } = disposable();
    const session = unGreeted(home, SID);
    try {
      const first = await startAt(env);
      const rows = await peersOf(first);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sid: SID,
        title: "a-repo@main",
        repo: "",
        ws: "",
        cwd: "/repos/a-repo/main",
        pinned: false,
      });
      // Live, and which of the two live classifications depends on whether a
      // terminal could be read off the process this test runs as.
      expect(rows[0]?.["state"]).toMatch(/^live/);
      // No connection has ever been open for it, so the row states neither a
      // generation nor when one was made.
      expect(rows[0]?.["protocol_version"]).toBeUndefined();
      expect(rows[0]?.["connected_at"]).toBeUndefined();
      await first.stop();

      // The restart knows nothing the first run knew, and the session says
      // nothing to it: the row comes back out of the directory alone.
      const second = await startAt(env);
      expect((await peersOf(second)).map((row) => row["sid"])).toEqual([SID]);
    } finally {
      session.stop();
    }
  });

  test("is reached by route (a), which reads the same file", async () => {
    const { env, home } = disposable();
    const session = unGreeted(home, SID);
    try {
      const instance = await startAt(env);
      const client = await greet(instance);
      client.send({ op: "message.send", request_id: "send", to: SID, text: "after a restart" });
      expect(await client.next()).toMatchObject({ ok: true, delivered: true });

      const until = Date.now() + 1_000;
      while (session.lines.length < 2 && Date.now() < until) await Bun.sleep(1);
      const [auth, user] = session.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(auth).toMatchObject({ type: "auth" });
      expect(user).toMatchObject({ type: "user", session_id: SID });
    } finally {
      session.stop();
    }
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
      handlers["kv.read"]({} as never);
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(OpError);
    expect((refused as OpError).code).toBe("not_found");
    expect((refused as OpError).message).toContain("not implemented");
  });

  test("instance.shutdown is answered before the instance goes", async () => {
    const { env } = disposable();
    const instance = await startAt(env);
    const client = await greet(instance);
    client.send({ op: "instance.shutdown", request_id: "bye" });
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
      // A ping is asked of a connection that has said who it is, like every
      // other op: greeting is what makes the caller somebody to answer.
      client.send({ op: "hello.user", request_id: "hello", protocol_version: PROTOCOL_VERSION });
      expect((await client.next())["ok"]).toBe(true);
      client.send({ op: "instance.ping", request_id: "ping" });
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
        op: "hello.user",
        request_id: "hello",
        protocol_version: PROTOCOL_VERSION,
      });
      const greeting = await client.next();
      expect(greeting["ok"]).toBe(true);
      expect(greeting["protocol_version"]).toBe(PROTOCOL_VERSION);
      client.send({ op: "topic.subscribe", request_id: "sub", topic: "peers" });
      expect((await client.next())["ok"]).toBe(true);
      expect((await client.next())["snapshot"]).toBe(true);

      client.send({ op: "instance.shutdown", request_id: "bye" });
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
    op: "hello.user",
    request_id: "hello",
    protocol_version: PROTOCOL_VERSION,
  });
  await client.next();
  client.send({ op: "instance.shutdown", request_id: "bye" });
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

/** The declarations a config file writes against, held to what the instance
 * actually reads.
 *
 * They are a copy — self-contained on purpose, so that a relative
 * `import type` resolves in a config home with no tsconfig and no
 * node_modules near it — and a copy is a thing that drifts. This is where it
 * is caught: a field added, renamed or retyped on one side and not the other
 * stops the build rather than reaching a person as a type that quietly says
 * the wrong thing. */
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// `peers` is the one field of a config that no file writes: it is derived from
// the instances of this host and `peers.json`, so the declarations a person
// writes against do not offer it.
type Written = Exclude<keyof InstanceConfig, "peers">;
// `endpoint` and `name` are an instance's own to state, like `dir`: the shared
// file could not say any of them once for everybody.
export type _ConfigFields = Assert<Same<Exclude<Written, "endpoint">, keyof Draft>>;
export type _InstanceFields = Assert<Same<Written | "dir" | "name", keyof InstanceDraft>>;
// Down through the shapes that hang below it, since a field added inside the
// launcher or an entry is as invisible from the top level as one added beside
// them. What the copy states differently on purpose is optionality: a file may
// leave out what the parser fills in, so the fields are compared and the
// requiredness is not.
export type _EntryFields = Assert<Same<keyof EntryConfig, keyof NonNullable<Draft["entry"]>>>;
export type _UpstreamFields = Assert<Same<keyof UpstreamConfig, keyof Draft["upstream"]>>;
export type _LauncherFields = Assert<
  Same<keyof LauncherConfig, keyof NonNullable<Draft["upstream"]["launcher"]>>
>;
export type _DumpFields = Assert<Same<keyof DumpConfig, keyof Draft["dump"]>>;
