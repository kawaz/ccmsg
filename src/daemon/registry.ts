import { existsSync, mkdirSync, watch } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { InstanceId, InstancePingResult } from "@ccmsg/protocol";
import {
  type InstanceEntry,
  loadShared,
  parseConfig,
  saveShared,
  settingsFor,
  type SharedConfig,
} from "../instance/config.ts";
import { selfId } from "../instance/instance.ts";
import { alive, lockHolder } from "../instance/lock.ts";
import { type Env, type InstancePaths, resolvePaths } from "../instance/paths.ts";
import { prepareSocketDir } from "../instance/socket.ts";
import { connect, greetAsUser } from "./control.ts";
import { CommandError } from "./link.ts";

/** What a config home has to be for an instance to answer for it.
 *
 * `settings.json` is the harness's own file, so its presence is what says the
 * directory is a config home rather than any directory somebody typed. Checked
 * where a directory is named — `add` and `run` — rather than at every use, so
 * the mistake is caught when it is made. */
export function configHome(dir: string): string {
  const path = isAbsolute(dir) ? dir : resolve(dir);
  if (!existsSync(join(path, "settings.json"))) {
    throw new CommandError(
      "not_found",
      `${path} は Claude Code の config home ではありません (settings.json がありません)`,
    );
  }
  return path;
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
  readonly version?: string;
  readonly network?: InstancePingResult["network"];
  readonly peers?: readonly InstanceId[];
}

/** Everything one command needs to reach one config home. */
export interface Target {
  readonly dir: string;
  readonly paths: InstancePaths;
}

export function targetFor(env: Env, dir: string): Target {
  return { dir, paths: resolvePaths({ ...env, CLAUDE_CONFIG_DIR: dir }) };
}

/** The config homes the shared file lists, in the order it lists them. */
export function registered(env: Env): Target[] {
  const paths = resolvePaths(env);
  return loadShared(paths.configFile).instances.map((entry) => targetFor(env, entry.dir));
}

/** Add a config home to the shared file. The settings it will run with are the
 * defaults until somebody edits its entry, so the entry starts empty. */
export function add(env: Env, dir: string): InstanceRow {
  const home = configHome(dir);
  const file = resolvePaths(env).configFile;
  const shared = loadShared(file);
  if (shared.instances.some((entry) => entry.dir === home)) {
    throw new CommandError("file_exists", `${home} は既に登録されています`);
  }
  const entry: InstanceEntry = { dir: home, settings: {} };
  saveShared(file, { ...shared, instances: [...shared.instances, entry] });
  return rowFor(targetFor(env, home));
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
 * Derived rather than asked, so a stopped instance still has the name the
 * running one answers to: the id follows from the config home's key and the
 * address the config binds, both of which are readable without it. */
export function idOf(target: Target): InstanceId {
  const shared = loadShared(target.paths.configFile);
  const config = parseConfig(target.paths.configFile, settingsFor(shared, target.dir));
  return selfId(target.paths.key, config);
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
  const row = rowFor(target);
  const conn = await connect(target.paths.socket);
  if (conn === undefined) return row;
  try {
    const greeting = await greetAsUser(conn);
    if (greeting["ok"] !== true) return row;
    const peers = (greeting["instances"] as { id: InstanceId }[] | undefined) ?? [];
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
      peers: peers.map((one) => one.id).filter((id) => id !== ping.instance),
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
  const proc = Bun.spawn([process.execPath, ENTRY, "daemon", "run", dir], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...env, CLAUDE_CONFIG_DIR: dir } as Record<string, string>,
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
