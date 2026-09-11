import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Endpoint, InstanceId, InstancePingResult } from "@ccmsg/protocol";
import { DEFAULT_HARNESS, type Harness, HARNESS, HARNESSES } from "../harness/index.ts";
import {
  applied,
  type ConfigProblem,
  CONFIG_FILE,
  CONFIG_NAME,
  configOf,
  DEFAULT_CONFIG,
  type EndpointRow,
  ENDPOINTS_FILE,
  evaluate,
  type InstanceConfig,
  instanceFileName,
  type InstanceSetting,
  type Satisfied,
  settle,
  SUPERVISOR_FILE,
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
  const found = (await known(env)).instances.find((one) => one.dir === path);
  return found?.config.harness ?? DEFAULT_HARNESS;
}

/** What this host runs: the settings that are applied, read again from the
 * files when they check out.
 *
 * Every command goes through the one path — read, check, apply — so what a
 * command acts on is what a start would run. A config that does not check out
 * leaves the applied one standing, which is what keeps a command about one
 * instance working while another instance's file is being edited. */
export async function known(env: Env): Promise<Satisfied> {
  const paths = resolvePaths(env);
  const read = await evaluate(paths.configDir);
  return read.satisfied ?? applied(paths.stateRoot) ?? EMPTY_SATISFIED;
}

const EMPTY_SATISFIED: Satisfied = {
  endpoints: [],
  supervisor: { instances: [] },
  instances: [],
};

/** Read the files, check them, and write down what holds — the one thing a
 * start, a reload, an `add` and a `remove` all do. */
export async function reload(env: Env): Promise<{
  satisfied: Satisfied;
  problems: readonly ConfigProblem[];
}> {
  const paths = resolvePaths(env);
  const settled = await settle(paths.configDir, paths.stateRoot);
  return { satisfied: settled.satisfied, problems: settled.problems };
}

/** One row of `daemon list`: which config home, and whether anything answers
 * for it right now. */
export interface InstanceRow {
  readonly id: InstanceId;
  /** The label this instance is listed under: its own file's `name`, which
   * defaults to its id. A `daemon run` on a config home nothing states
   * settings for has none. */
  readonly name?: string;
  readonly dir: string;
  /** The address it binds, and the one its peers dial (§7.1). */
  readonly port?: number;
  readonly endpoint?: string;
  readonly running: boolean;
  readonly pid?: number;
}

/** One row of `daemon status`: the list's row, plus what the instance itself
 * says when there is one to ask. */
export interface StatusRow extends InstanceRow {
  /** What was wrong with the files, where the applied settings are older than
   * what is written. */
  readonly config_problems?: readonly ConfigProblem[];
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
  /** The label this instance is listed under, where it is registered. */
  readonly name?: string;
  /** Its id, which is what its file is called. */
  readonly id?: string;
  readonly dir: string;
  readonly paths: InstancePaths;
}

export function targetFor(env: Env, dir: string, name?: string, id?: string): Target {
  return {
    ...(name === undefined ? {} : { name }),
    ...(id === undefined ? {} : { id }),
    dir,
    paths: resolvePathsFor(dir, env),
  };
}

/** The config homes this host starts, in the order the supervisor lists them. */
export async function registered(env: Env): Promise<Target[]> {
  return (await known(env)).instances.map((entry) =>
    targetFor(env, entry.dir, entry.name, entry.id),
  );
}

/** The instance a command was given, by any of the three things a person has
 * to hand: the label it is listed under, its id, or the directory itself. */
export async function targetNamed(env: Env, ref: string): Promise<Target | undefined> {
  return (await registered(env)).find(
    (target) => target.name === ref || target.id === ref || target.dir === ref,
  );
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

/** What a config home is called, for a person reading a listing: its own last
 * segment, without the dot a config home is usually hidden by.
 *
 * A label and not an identity — the file and everything the instance issued
 * are keyed by its id, so this may be changed in the file afterwards. Taken
 * from the directory because that is the one of the two that already exists;
 * a directory whose name could not be a label leaves the id as the name, which
 * is what a name defaults to anyway. */
export function nameFor(dir: string): string {
  const name = basename(dir).replace(/^\.+/, "");
  return CONFIG_NAME.test(name) ? name : "";
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
 * differs from the shared file, which is what makes that file worth having:
 * everything left out is whatever that file returns.
 *
 * The shared file is written the first time, with the dump presets in it, and never
 * again: what a preset names is an interest this instance has no opinion on, so
 * they are examples in a file to edit rather than a default in the code that
 * would come back after being deleted. */
export async function add(env: Env, dir: string, options: AddOptions = {}): Promise<InstanceRow> {
  const where = isAbsolute(dir) ? dir : resolve(dir);
  const harness = options.harness ?? harnessOf(where);
  const home = configHome(where, harness);
  const paths = resolvePaths(env);
  const held = await known(env);
  const taken = held.instances.find((one) => one.dir === home);
  if (taken !== undefined) {
    throw new CommandError("file_exists", `${home} は既に ${taken.name} として登録されています`);
  }
  // The id the state directory already holds, or a new one written there now:
  // a config home that was registered before keeps the id everything it issued
  // is keyed by, and a fresh one gets its id here rather than at its first
  // start (DR-0001 §2.1).
  const id = instanceIdentity(targetFor(env, home).paths.instanceIdFile);
  // Every instance listens, because an instance is an entry of the mesh (§7.1)
  // and a mesh is reached over the entry: what `--port` settles is which
  // address, not whether there is one.
  const port =
    options.port ??
    (await freePort(
      held.instances.flatMap((one) =>
        one.config.entry === undefined ? [] : [one.config.entry.port],
      ),
    ));
  const name = nameFor(home) || id;
  writeConfigTypes(paths.configDir);
  if (!existsSync(paths.configFile)) writeFileSync(paths.configFile, defaultsTemplate());
  mkdirSync(paths.instancesDir, { recursive: true });
  writeFileSync(
    join(paths.instancesDir, instanceFileName(id)),
    instanceTemplate(name, home, harness, port),
  );
  // The loopback address, because that is the one this host is certainly
  // reached at. A proxy in front of it is a deployment fact nothing here can
  // see, so an operator who has one edits this row (§8.2).
  saveEndpoints(paths.configDir, [
    ...readEndpointRows(paths.configDir).filter((row) => row.id !== id),
    { id, endpoint: `http://127.0.0.1:${String(port)}/` as EndpointRow["endpoint"] },
  ]);
  saveSupervisor(paths.configDir, [
    ...readSupervised(paths.configDir).filter((one) => one !== id),
    id,
  ]);
  const settled = await reload(env);
  const written = configOf(settled.satisfied, home);
  if (written === undefined) {
    throw new CommandError(
      "internal_error",
      `${home} を書きましたが設定が通りませんでした: ${settled.problems
        .map((one) => `${one.file}: ${one.msg}`)
        .join("; ")}`,
    );
  }
  return rowOf(env, written);
}

/** The mesh as the file holds it right now, for a command that is about to
 * edit it. Read as data rather than through the checks, because a command that
 * adds a row has to be able to fix a file that does not check out yet. */
function readEndpointRows(configDir: string): EndpointRow[] {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, ENDPOINTS_FILE), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as EndpointRow[]) : [];
  } catch {
    return [];
  }
}

function readSupervised(configDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, SUPERVISOR_FILE), "utf8")) as {
      instances?: unknown;
    };
    return Array.isArray(parsed.instances) ? (parsed.instances as string[]) : [];
  } catch {
    return [];
  }
}

function saveEndpoints(configDir: string, rows: readonly EndpointRow[]): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ENDPOINTS_FILE), `${JSON.stringify(rows, null, 2)}\n`);
}

function saveSupervisor(configDir: string, ids: readonly string[]): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, SUPERVISOR_FILE),
    `${JSON.stringify({ instances: ids }, null, 2)}\n`,
  );
}

/** Take one instance's file away.
 *
 * The instance it named is left alone: what this changes is what the supervisor
 * starts and what `--all` reaches, and an instance already serving a session is
 * not something a file edit should take away from it. `daemon stop` is how one
 * is stopped, and saying so is the point of keeping the two apart. */
export async function remove(
  env: Env,
  ref: string,
): Promise<{ id: string; name: string; dir: string; removed: boolean }> {
  const paths = resolvePaths(env);
  const found = (await known(env)).instances.find(
    (one) => one.id === ref || one.name === ref || one.dir === ref,
  );
  if (found === undefined) throw new CommandError("not_found", `${ref} は登録されていません`);
  saveSupervisor(
    paths.configDir,
    readSupervised(paths.configDir).filter((one) => one !== found.id),
  );
  saveEndpoints(
    paths.configDir,
    readEndpointRows(paths.configDir).filter((row) => row.id !== found.id),
  );
  rmSync(join(paths.instancesDir, instanceFileName(found.id)), { force: true });
  // The state directory stays, its id with it: what the instance issued is
  // keyed by that id, and re-adding the same config home has to answer to the
  // same one.
  await reload(env);
  return { id: found.id, name: found.name, dir: found.dir, removed: true };
}

/** The file every instance's settings start from, as it is first written. */
function defaultsTemplate(): string {
  return `import type { Defaults } from "./${TYPES_FILE.replace(/\.d\.ts$/, "")}";

/** 全 instance に配る値。\`builtin\` は組み込みの既定値 (凍結済み)、\`config\` は
 * そのコピーなので、書き換えて返す。ここに書いた値を各 instance が受け取る。 */
const defaults: Defaults = ({ config }) => {
  // mesh はここには書かない。誰が居てどこで届くかは endpoints.json が正で、
  // この関数は読めるが変えられない。

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
 * the shared file, and nothing else. */
function instanceTemplate(name: string, dir: string, harness: Harness, port: number): string {
  const lines = [
    `  config.name = ${JSON.stringify(name)};`,
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

/** What `daemon list` answers: the instances this host starts, and whether
 * anything answers for each right now. */
export async function list(env: Env): Promise<InstanceRow[]> {
  return (await known(env)).instances.map((one) => rowOf(env, one));
}

function rowOf(env: Env, one: InstanceSetting): InstanceRow {
  return {
    ...rowFor(targetFor(env, one.dir, one.name, one.id)),
    ...(one.config.entry === undefined ? {} : { port: one.config.entry.port }),
    ...(one.config.endpoint === undefined ? {} : { endpoint: one.config.endpoint }),
  };
}

/** Ask one instance how it is. A config home with nothing behind it answers the
 * list's row and nothing more: not running is a state, not a failure. */
export async function status(target: Target): Promise<StatusRow> {
  const read = await evaluate(target.paths.configDir);
  const satisfied = read.satisfied ?? applied(target.paths.stateRoot) ?? EMPTY_SATISFIED;
  const own = configOf(satisfied, target.dir);
  const row = {
    ...rowFor(target),
    ...(own?.config.entry === undefined ? {} : { port: own.config.entry.port }),
    ...(own?.config.endpoint === undefined ? {} : { endpoint: own.config.endpoint }),
    config: own?.config ?? DEFAULT_CONFIG,
    // What a person has to be told even though the instance is running: an
    // edit that did not check out is not applied, and the only sign of it
    // otherwise is a setting that did not take (§8.3).
    ...(read.problems.length === 0 ? {} : { config_problems: read.problems }),
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
