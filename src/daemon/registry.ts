import { existsSync, mkdirSync, watch } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Endpoint, InstanceId, InstancePingResult } from "@ccmsg/protocol";
import { DEFAULT_HARNESS, type Harness, HARNESS, isHarness } from "../harness/index.ts";
import {
  type InstanceConfig,
  type InstanceEntry,
  loadConfig,
  loadShared,
  saveShared,
  settingsFor,
  type SharedConfig,
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

/** Which harness a registered config home runs, as the shared file records it.
 *
 * Read from the same entry the instance itself will read (§8.2), so a command
 * that has to know before anything is running — `run`, and the supervisor's
 * own start — reaches the same answer the instance does. A directory the file
 * does not list runs the default, which is what an unregistered `daemon run`
 * is. */
export function harnessFor(env: Env, dir: string): Harness {
  const path = isAbsolute(dir) ? dir : resolve(dir);
  const settings = settingsFor(loadShared(resolvePaths(env).configFile), path);
  const named = settings["harness"];
  return isHarness(named) ? named : DEFAULT_HARNESS;
}

/** One row of `daemon list`: which config home, and whether anything answers
 * for it right now. */
export interface InstanceRow {
  readonly id: InstanceId;
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
  readonly dir: string;
  readonly paths: InstancePaths;
}

export function targetFor(env: Env, dir: string): Target {
  return { dir, paths: resolvePathsFor(dir, env) };
}

/** The config homes the shared file lists, in the order it lists them. */
export function registered(env: Env): Target[] {
  const paths = resolvePaths(env);
  return loadShared(paths.configFile).instances.map((entry) => targetFor(env, entry.dir));
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
    opts: { types: ["tool:Read", "tool:Write", "tool:Edit", "tool:Glob", "tool:Grep"] },
  },
  {
    name: "howto",
    description: "調査のノウハウだけ。何を考えて何を叩いて何を読み書きしたか",
    opts: {
      types: ["thinking", "message:user", "message:parent", "message:sub", "tool:Bash", "@file"],
    },
  },
  {
    name: "journal",
    description: "日記用。人との往復と worker の答え、思考は要点だけ",
    opts: {
      types: ["message:user", "message:parent", "message:sub:in", "message:team:in", "thinking"],
    },
  },
  {
    name: "handoff",
    description: "後継セッションへの引き継ぎ。直近の会話と、走っているものの台帳",
    opts: { types: ["message", "system:task", "ids"] },
  },
  {
    name: "audit",
    description: "何をしたかの追跡。会話は落として操作と通知だけ",
    opts: { types: ["@file", "tool:Bash", "notice", "ids"] },
  },
];

/** Add a config home to the shared file. The settings it will run with are the
 * defaults until somebody edits its entry, so the entry starts empty — save
 * for the harness, which is written down when it is not the default because it
 * is the one setting the directory itself cannot be asked for (§3.8).
 *
 * The dump presets above go to `defaults`, and only where the file names none:
 * they are the same for every instance and are examples to edit, so writing
 * them per entry would repeat them and re-adding a config home would bring
 * back what somebody deleted. */
export function add(env: Env, dir: string, harness: Harness = DEFAULT_HARNESS): InstanceRow {
  const home = configHome(dir, harness);
  const file = resolvePaths(env).configFile;
  const shared = loadShared(file);
  if (shared.instances.some((entry) => entry.dir === home)) {
    throw new CommandError("file_exists", `${home} は既に登録されています`);
  }
  const entry: InstanceEntry = {
    dir: home,
    settings: harness === DEFAULT_HARNESS ? {} : { harness },
  };
  const defaults =
    shared.defaults["dump"] === undefined
      ? { ...shared.defaults, dump: { presets: STARTING_PRESETS } }
      : shared.defaults;
  saveShared(file, { defaults, instances: [...shared.instances, entry] });
  const target = targetFor(env, home);
  // The id is made here rather than at the first start, so that what `add`
  // prints is what the instance will answer to and so that a person can write
  // the id into a peer's config before anything has run (DR-0001 §2.1).
  instanceIdentity(target.paths.instanceIdFile);
  return rowFor(target);
}

/** Take a config home off the list.
 *
 * The instance it names is left alone: what this changes is what the supervisor
 * starts and what `--all` reaches, and an instance already serving a session is
 * not something a list edit should take away from it. `daemon stop` is how one
 * is stopped, and saying so is the point of keeping the two apart. */
export function remove(env: Env, dir: string): { dir: string; removed: boolean } {
  const home = isAbsolute(dir) ? dir : resolve(dir);
  const file = resolvePaths(env).configFile;
  const shared: SharedConfig = loadShared(file);
  const kept = shared.instances.filter((entry) => entry.dir !== home);
  if (kept.length === shared.instances.length) {
    throw new CommandError("not_found", `${home} は登録されていません`);
  }
  saveShared(file, { ...shared, instances: kept });
  return { dir: home, removed: true };
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
    dir: target.dir,
    running,
    ...(running ? { pid } : {}),
  };
}

export function list(env: Env): InstanceRow[] {
  return registered(env).map((target) => rowFor(target));
}

/** Ask one instance how it is. A config home with nothing behind it answers the
 * list's row and nothing more: not running is a state, not a failure. */
export async function status(target: Target): Promise<StatusRow> {
  const row = { ...rowFor(target), config: loadConfig(target.paths.configFile, target.dir) };
  const conn = await connect(target.paths.socket);
  if (conn === undefined) return row;
  try {
    const greeting = await greetAsUser(conn);
    if (greeting["ok"] !== true) return row;
    const peers =
      (greeting["instances"] as { id: InstanceId; endpoint: Endpoint }[] | undefined) ?? [];
    const answer = await conn.ask({ op: "instance_ping" });
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
    const answer = await conn.ask({ op: "instance_shutdown" });
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
