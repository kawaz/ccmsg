import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Endpoint, InstanceId, InstancePingResult } from "@ccmsg/protocol";
import { DEFAULT_HARNESS, type Harness, HARNESS, HARNESSES } from "../harness/index.ts";
import {
  CONFIG_FILE,
  type InstanceConfig,
  INSTANCE_NAME,
  loadAll,
  loadConfig,
  loadInstances,
  TYPES_FILE,
  writeConfigTypes,
} from "../instance/config.ts";
import { instanceIdentity } from "../instance/identity.ts";
import { alive, lockHolder } from "../instance/lock.ts";
import { type Env, type InstancePaths, resolvePaths, resolvePathsFor } from "../instance/paths.ts";
import { prepareSocketDir } from "../instance/socket.ts";
import { connect, greetAsUser } from "./control.ts";
import { CommandError } from "./link.ts";

/** What a config home has to be for an instance to answer for it.
 *
 * The harness's own settings file is what says the directory is a config home
 * rather than any directory somebody typed, so which file is looked for
 * follows which harness the directory runs (§3.8). Checked where a directory
 * is named — `add` and `run` — rather than at every use, so the mistake is
 * caught when it is made. */
export function configHome(dir: string, harness: Harness = DEFAULT_HARNESS): string {
  const path = isAbsolute(dir) ? dir : resolve(dir);
  const marker = HARNESS[harness].marker;
  if (!existsSync(join(path, marker))) {
    throw new CommandError(
      "not_found",
      `${path} は ${harness} の config home ではありません (${marker} がありません)`,
    );
  }
  return path;
}

/** Which harness a registered config home runs, as its own file says.
 *
 * Read from the same file the instance itself will read (§8.2), so a command
 * that has to know before anything is running — `run`, and the supervisor's
 * own start — reaches the same answer the instance does. A directory no file
 * names runs whatever the defaults say, which is what an unregistered
 * `daemon run` is. */
export async function harnessFor(env: Env, dir: string): Promise<Harness> {
  const path = isAbsolute(dir) ? dir : resolve(dir);
  return (await loadConfig(resolvePaths(env).configDir, path)).harness;
}

/** One row of `daemon list`: which config home, and whether anything answers
 * for it right now. */
export interface InstanceRow {
  readonly id: InstanceId;
  /** What the file naming this config home is called, where a file names it.
   * A `daemon run` on an unregistered directory has none. */
  readonly name?: string;
  readonly dir: string;
  readonly running: boolean;
  readonly pid?: number;
}

/** One row of `daemon status`: the list's row, plus what the instance itself
 * says when there is one to ask. */
export interface StatusRow extends InstanceRow {
  /** What this config home's instance is configured with, after the shared
   * file's defaults and its own entry are merged (§8.2).
   *
   * Answered whether or not anything is running, and read from the file rather
   * than asked of the instance: this is what a restart would apply, which is
   * the question an operator who just edited the file has. It carries no
   * secret — the gateway's token is named by the path it is kept at. */
  readonly config: InstanceConfig;
  readonly version?: string;
  readonly network?: InstancePingResult["network"];
  /** The other instances this one names, each with where it is dialled: the id
   * says which instance and the endpoint says how to reach it, and neither
   * follows from the other (DR-0001 §2.1). */
  readonly peers?: readonly { readonly id: InstanceId; readonly endpoint: Endpoint }[];
}

/** Everything one command needs to reach one config home. */
export interface Target {
  /** The name of the file that says this config home runs an instance, where
   * one does. */
  readonly name?: string;
  readonly dir: string;
  readonly paths: InstancePaths;
}

export function targetFor(env: Env, dir: string, name?: string): Target {
  return { ...(name === undefined ? {} : { name }), dir, paths: resolvePathsFor(dir, env) };
}

/** The config homes the config dir names, in name order. */
export async function registered(env: Env): Promise<Target[]> {
  const paths = resolvePaths(env);
  return (await loadInstances(paths.configDir)).map((entry) =>
    targetFor(env, entry.dir, entry.name),
  );
}

/** The config home one name is for, for a command given a name instead of a
 * directory: what `daemon add` took is what every command after it takes. */
export async function targetNamed(env: Env, name: string): Promise<Target | undefined> {
  return (await registered(env)).find((target) => target.name === name);
}

/** The selections the shared file starts with.
 *
 * Presets are the operator's to name — what one names is an interest, and this
 * instance has no opinion on which interests a person has — so these are
 * written into the file as examples to edit rather than built in. A default
 * that lived in the code would be invisible in the file and would come back
 * after being deleted.
 *
 * They also show the two things a person would otherwise have to be told: that
 * a prefix takes a family, and that `@name` puts one selection inside
 * another. */
const STARTING_PRESETS = [
  {
    name: "file",
    description: "ファイル操作。読み書きと探索をひとまとめに",
    opts: { types: ["tool.Read", "tool.Write", "tool.Edit", "tool.Glob", "tool.Grep"] },
  },
  {
    name: "howto",
    description: "調査のノウハウだけ。何を考えて何を叩いて何を読み書きしたか",
    opts: {
      types: ["thinking", "message.user", "message.parent", "message.sub", "tool.Bash", "@file"],
    },
  },
  {
    name: "journal",
    description: "日記用。人との往復と worker の答え、思考は要点だけ",
    opts: {
      types: ["message.user", "message.parent", "message.sub.in", "message.team.in", "thinking"],
    },
  },
  {
    name: "handoff",
    description: "後継セッションへの引き継ぎ。直近の会話と、走っているものの台帳",
    opts: { types: ["message", "system.task", "ids"] },
  },
  {
    name: "audit",
    description: "何をしたかの追跡。会話は落として操作と通知だけ",
    opts: { types: ["@file", "tool.Bash", "notice", "ids"] },
  },
];

/** What `daemon add` takes: the config home the instance answers for, and the
 * two settings a person would otherwise open the file to write. */
export interface AddOptions {
  readonly harness?: Harness;
  readonly port?: number;
}

/** What a config home is called as an instance: its own last segment, without
 * the dot a config home is usually hidden by.
 *
 * Taken from the directory rather than asked for, because the two would then
 * be a pair a person has to keep straight, and the directory is the one of
 * them that already exists. `.claude-personal` is `claude-personal`; a
 * directory whose name is not one an instance may be called is refused here,
 * where the name is being chosen, rather than at the file that would carry
 * it. */
export function nameFor(dir: string): string {
  const name = basename(dir).replace(/^\.+/, "");
  if (!INSTANCE_NAME.test(name)) {
    throw new CommandError(
      "invalid_args",
      `${dir} からは instance の名前が付けられません (小文字・数字・ダッシュだけの名前になりません)`,
    );
  }
  return name;
}

/** Which harness a config home runs, as the directory itself says.
 *
 * The marker file is the evidence: Claude Code keeps `settings.json` and Codex
 * keeps `config.toml`, so a directory that holds one of them is that harness's
 * (§3.8). A directory holding both, or neither, is not answered for — the
 * first is two answers and the second is none, and guessing either way writes
 * down a setting the instance will act on for the whole of its life. */
export function harnessOf(dir: string): Harness {
  const found = HARNESSES.filter((harness) => existsSync(join(dir, HARNESS[harness].marker)));
  const only = found[0];
  if (found.length !== 1 || only === undefined) {
    throw new CommandError(
      "invalid_args",
      found.length === 0
        ? `${dir} がどの harness の config home か分かりません (${HARNESSES.map((one) => HARNESS[one].marker).join(" / ")} がありません)。--harness で指定してください`
        : `${dir} は ${found.join(" と ")} の両方の目印を持っています。--harness で指定してください`,
    );
  }
  return only;
}

/** The port the next instance listens on: one past the highest any registered
 * instance holds, or the first of the range when there are none.
 *
 * Counted from what is configured and then confirmed against the kernel,
 * because the two answer different questions — the first is what this host has
 * already handed out, and the second is whether anything else on the machine
 * is on it. A person who wants a particular port says so and gets it or gets
 * the refusal. */
export const FIRST_PORT = 8643;

/** How far the search walks before it says so rather than going on. A run of
 * this many taken ports is a host whose ports are somebody else's business. */
const PORT_SEARCH = 64;

export async function freePort(taken: readonly number[]): Promise<number> {
  const first = taken.length === 0 ? FIRST_PORT : Math.max(...taken) + 1;
  for (let port = first; port < first + PORT_SEARCH; port += 1) {
    if (taken.includes(port)) continue;
    if (await bindable(port)) return port;
  }
  throw new CommandError(
    "internal_error",
    `${String(first)} から ${String(PORT_SEARCH)} 個のポートが全部塞がっています。--port で指定してください`,
  );
}

/** Whether this host will give out an address, asked by taking it and letting
 * it go again. Nothing else answers it: a port is free when the kernel says
 * so, and every other account of it is out of date the moment it is read. */
async function bindable(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") });
    await server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Write down one more instance: one file under `instances/`, called by the
 * name the instance is called.
 *
 * A template rather than an empty file, because what the file has to say —
 * which config home, and how a setting is written at all — is exactly what a
 * person adding their second instance does not yet know. It states only what
 * differs from `config.ts`, which is what makes the shared half worth having:
 * everything left out is whatever that file returns.
 *
 * `config.ts` is written the first time, with the dump presets in it, and never
 * again: what a preset names is an interest this instance has no opinion on, so
 * they are examples in a file to edit rather than a default in the code that
 * would come back after being deleted. */
export async function add(env: Env, dir: string, options: AddOptions = {}): Promise<InstanceRow> {
  const where = isAbsolute(dir) ? dir : resolve(dir);
  const harness = options.harness ?? harnessOf(where);
  const home = configHome(where, harness);
  const name = nameFor(home);
  const paths = resolvePaths(env);
  const file = join(paths.instancesDir, `${name}.ts`);
  if (existsSync(file)) {
    throw new CommandError("file_exists", `${name} は既に登録されています (${file})`);
  }
  const registered = (await loadAll(paths.configDir)).instances;
  const taken = registered.find((one) => one.dir === home);
  if (taken !== undefined) {
    throw new CommandError("file_exists", `${home} は既に ${taken.name} が見ています`);
  }
  // Every instance listens, because every instance is in the mesh of this host
  // (§7.1) and a mesh is reached over the entry: what `--port` settles is which
  // address, not whether there is one.
  const port =
    options.port ??
    (await freePort(
      registered.flatMap((one) => (one.config.entry === undefined ? [] : [one.config.entry.port])),
    ));
  writeConfigTypes(paths.configDir);
  if (!existsSync(paths.configFile)) writeFileSync(paths.configFile, defaultsTemplate());
  mkdirSync(paths.instancesDir, { recursive: true });
  writeFileSync(file, instanceTemplate(name, home, harness, port));
  const target = targetFor(env, home, name);
  // The id is made here rather than at the first start, so that what `add`
  // prints is what the instance will answer to and so that a person can write
  // the id into a peer's config before anything has run (DR-0001 §2.1).
  instanceIdentity(target.paths.instanceIdFile);
  return rowFor(target);
}

/** Take one instance's file away.
 *
 * The instance it named is left alone: what this changes is what the supervisor
 * starts and what `--all` reaches, and an instance already serving a session is
 * not something a file edit should take away from it. `daemon stop` is how one
 * is stopped, and saying so is the point of keeping the two apart. */
export async function remove(
  env: Env,
  name: string,
): Promise<{ name: string; dir: string; removed: boolean }> {
  const paths = resolvePaths(env);
  const target = await targetNamed(env, name);
  if (target === undefined) throw new CommandError("not_found", `${name} は登録されていません`);
  rmSync(join(paths.instancesDir, `${name}.ts`));
  return { name, dir: target.dir, removed: true };
}

/** The file every instance's settings start from, as it is first written. */
function defaultsTemplate(): string {
  return `import type { Defaults } from "./${TYPES_FILE.replace(/\.d\.ts$/, "")}";

/** 全 instance に配る値。\`builtin\` は組み込みの既定値 (凍結済み)、\`config\` は
 * そのコピーなので、書き換えて返す。ここに書いた値を各 instance が受け取る。 */
const defaults: Defaults = ({ config }) => {
  // mesh の相手はここには書かない。この host の instance は instances/ の各
  // ファイルから、別 host の endpoint は peers.json (ccmsg mesh add) から入る。

  // dump の名前付き選択。prefix は一族を、\`@name\` は他の選択をその場に広げる。
  config.dump.presets = [
${STARTING_PRESETS.map((preset) => presetLiteral(preset)).join("\n")}
  ];

  return config;
};

export default defaults;
`;
}

/** One starting preset as a person would have typed it.
 *
 * Written out rather than stringified, because what this produces is a file
 * somebody edits: JSON's quoted keys in the middle of a TypeScript file are
 * the shape of a thing that was generated, and the next preset a person adds
 * beside it would not look like it. */
function presetLiteral(preset: (typeof STARTING_PRESETS)[number]): string {
  const types = preset.opts.types.map((type) => JSON.stringify(type)).join(", ");
  return [
    "    {",
    `      name: ${JSON.stringify(preset.name)},`,
    `      description: ${JSON.stringify(preset.description)},`,
    `      opts: { types: [${types}] },`,
    "    },",
  ].join("\n");
}

/** One instance's file, as `add` first writes it: what differs from
 * `config.ts`, and nothing else. */
function instanceTemplate(name: string, dir: string, harness: Harness, port: number): string {
  const lines = [
    `  config.dir = ${JSON.stringify(dir)};`,
    "",
    "  // reverse proxy の後ろに居るなら、peer と人が届く公開 URL (末尾 /) を書く。",
    "  // 書かなければ下の待ち受け address がそのまま mesh の一覧に載る。",
    `  // config.endpoint = "https://ccmsg-${name}.<host>/";`,
    "",
  ];
  if (harness !== DEFAULT_HARNESS) lines.push(`  config.harness = ${JSON.stringify(harness)};`);
  lines.push(
    `  config.entry = {`,
    `    ...(config.entry ?? { host: "127.0.0.1", source_ips: [], trusted_proxies: [] }),`,
    `    port: ${String(port)},`,
    `  };`,
  );
  return `import type { Instance } from "../${TYPES_FILE.replace(/\.d\.ts$/, "")}";

/** ${name}: この instance だけの設定。\`default\` は ${CONFIG_FILE} が返した値
 * (凍結済み)、\`config\` はそのコピーなので、差分だけ書き換えて返す。 */
const instance: Instance = ({ config }) => {
${lines.join("\n")}

  return config;
};

export default instance;
`;
}

/** What an instance is called, whether or not it is running.
 *
 * Read from the state directory rather than asked, so a stopped instance still
 * has the name the running one answers to — and written there if it is not
 * there yet, which is what makes this total for a config home that has been
 * registered but never started (DR-0001 §2.1). */
export function idOf(target: Target): InstanceId {
  return instanceIdentity(target.paths.instanceIdFile);
}

export function rowFor(target: Target): InstanceRow {
  const pid = lockHolder(target.paths.lockFile);
  const running = pid !== undefined && alive(pid);
  return {
    id: idOf(target),
    ...(target.name === undefined ? {} : { name: target.name }),
    dir: target.dir,
    running,
    ...(running ? { pid } : {}),
  };
}

export async function list(env: Env): Promise<InstanceRow[]> {
  return (await registered(env)).map((target) => rowFor(target));
}

/** Ask one instance how it is. A config home with nothing behind it answers the
 * list's row and nothing more: not running is a state, not a failure. */
export async function status(target: Target): Promise<StatusRow> {
  const row = {
    ...rowFor(target),
    config: await loadConfig(target.paths.configDir, target.dir),
  };
  const conn = await connect(target.paths.socket);
  if (conn === undefined) return row;
  try {
    const greeting = await greetAsUser(conn);
    if (greeting["ok"] !== true) return row;
    const peers =
      (greeting["instances"] as { id: InstanceId; endpoint: Endpoint }[] | undefined) ?? [];
    const answer = await conn.ask({ op: "instance.ping" });
    if (answer["ok"] !== true) return row;
    const ping = answer as unknown as InstancePingResult;
    return {
      ...row,
      id: ping.instance,
      running: true,
      pid: ping.pid,
      version: ping.version,
      network: ping.network,
      peers: peers
        .filter((one) => one.id !== ping.instance)
        .map((one) => ({ id: one.id, endpoint: one.endpoint })),
    };
  } finally {
    conn.close();
  }
}

/** Ask one instance to stop, over its own socket.
 *
 * The contract's op rather than a signal, so the request goes through the same
 * authorization every other op does and the caller is told it was accepted
 * before the process goes down (§8.5). */
export async function stop(target: Target): Promise<{ dir: string; stopped: boolean }> {
  const conn = await connect(target.paths.socket);
  if (conn === undefined) {
    throw new CommandError("instance_unreachable", `${target.dir} の instance は動いていません`);
  }
  try {
    const greeting = await greetAsUser(conn);
    if (greeting["ok"] !== true) {
      throw new CommandError("forbidden", `hello が拒否されました: ${JSON.stringify(greeting)}`);
    }
    const answer = await conn.ask({ op: "instance.shutdown" });
    if (answer["ok"] !== true) {
      throw new CommandError("internal_error", `停止を拒否されました: ${JSON.stringify(answer)}`);
    }
    return { dir: target.dir, stopped: true };
  } finally {
    conn.close();
  }
}

/** How this process was started, so a child can be started the same way.
 *
 * The interpreter and the entry script rather than a name on `PATH`: a
 * supervisor that resolved `ccmsg` again could start a different build from the
 * one that spawned it, and which build is running is exactly what a person
 * chasing a stale instance is trying to find out. */
export const ENTRY = new URL("../cli.ts", import.meta.url).pathname;

export interface Child {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

/** How a child instance is started. Injected so a test drives the supervisor
 * without spawning one. */
export type SpawnInstance = (dir: string, env: Env) => Child;

export const spawnInstance: SpawnInstance = (dir, env) => {
  // The directory is an argument and not an environment variable: `daemon run`
  // takes it from there and hands it to the instance by value, so which config
  // home the child answers for cannot depend on which session the supervisor
  // was started from (§3.8).
  const proc = Bun.spawn([process.execPath, ENTRY, "daemon", "run", dir], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...env } as Record<string, string>,
  });
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: (signal) => {
      proc.kill(signal ?? "SIGTERM");
    },
  };
};

/** How long a start waits for the instance it spawned to be reachable before
 * reporting what it saw.
 *
 * A deadline rather than an interval: what is waited on is the socket appearing
 * or the child exiting, both of which are events, and this only bounds how long
 * a start that does neither may hold the caller. */
export const START_TIMEOUT_MS = 10_000;

/** The directories an instance will fill, made before the child that fills
 * them: a watch cannot report a change in a directory that does not exist. */
export function prepareFor(target: Target): void {
  mkdirSync(target.paths.stateDir, { recursive: true });
  prepareSocketDir(target.paths);
}

/** Wait for the stable socket to appear, on the directory's own change
 * notifications rather than on a clock.
 *
 * The check comes first and again after the watch is up, because the socket may
 * be published in the window between the two and a watch reports only what
 * happens after it starts. */
export function awaitSocket(paths: InstancePaths, timeoutMs: number): Promise<void> {
  return awaitEntry(paths, timeoutMs, () => existsSync(paths.socket));
}

/** Wait for the lock to be released, which is the last thing a departing
 * instance does (§8.5). */
export function awaitGone(paths: InstancePaths, timeoutMs: number): Promise<void> {
  return awaitEntry(paths, timeoutMs, () => {
    const pid = lockHolder(paths.lockFile);
    return pid === undefined || !alive(pid);
  });
}

function awaitEntry(paths: InstancePaths, timeoutMs: number, ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watchers: { close(): void }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (cause?: Error): void => {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const look = (): void => {
      if (ready()) done();
    };
    for (const dir of new Set([paths.socketDir, paths.stateDir])) {
      try {
        watchers.push(watch(dir, look));
      } catch {
        // The directory is not there yet; the other watch, or the deadline,
        // is what this run has.
      }
    }
    timer = setTimeout(() => {
      done(
        new CommandError(
          "internal_error",
          `${basename(paths.configHome)} の instance を ${String(timeoutMs)}ms 待ちましたが応答がありません`,
        ),
      );
    }, timeoutMs);
    look();
  });
}
