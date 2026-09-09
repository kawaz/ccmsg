import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

/** Every path one instance uses, decided in one place (daemon-v2 §8.1).
 *
 * All of them are derived from the config home, because the config home is
 * what an instance is (A2): two instances differ in exactly that, so deriving
 * from it is what keeps their sockets, state and logs apart without anyone
 * configuring the separation. */
export interface InstancePaths {
  /** The one config home this instance answers for (M6). */
  readonly configHome: string;
  /** What distinguishes this instance's files from another instance's. */
  readonly key: string;
  /** The one file a person edits, shared by every instance on this host: it
   * carries the defaults and the list of config homes, so it is not derived
   * from the config home the way the rest of these are. */
  readonly configFile: string;
  readonly stateDir: string;
  /** The address clients connect to. A symlink to whichever `socketReal` is
   * currently serving, so a client's path outlives the process behind it. */
  readonly socket: string;
  /** The path this process actually binds, named after its pid.
   *
   * Bun unlinks the path it listened on when the listener stops (measured
   * against Bun 1.3.13), so binding the stable path directly would mean a
   * departing instance deleting the address its successor had already taken
   * over (§8.5). Binding a path of its own leaves it deleting only its own. */
  readonly socketReal: string;
  /** Where both of the above live, so the orphan sweep has one directory. */
  readonly socketDir: string;
  /** Where the agent plugins this instance hands out are laid down, one
   * directory per agent. They live with the state because they are derived
   * from the binary: losing them costs an `install` and nothing else. */
  readonly pluginsDir: string;
  readonly pidFile: string;
  readonly lockFile: string;
  readonly logFile: string;
  /** Where this instance's own id is kept (§3.6). It lives with the state
   * because moving an instance is moving that directory: the id has to travel
   * with it, since everything the instance issued is keyed by it. */
  readonly instanceIdFile: string;
}

/** `sun_path` on macOS, the shorter of the two platforms this runs on
 * (measured in `sys/un.h`, 104 there and 108 on Linux). A path at or past it
 * cannot be bound at all, so it is checked rather than discovered as a
 * bind failure. */
const MAX_SOCKET_PATH = 104;

/** The stable address, and the name of the path one process binds. */
export const SOCKET_NAME = "daemon.sock";

export function realSocketName(pid: number): string {
  return `daemon.${pid}.sock`;
}

/** The real socket names this pattern produces, for the sweep that removes the
 * ones whose process is gone. */
export const REAL_SOCKET = /^daemon\.(\d+)\.sock$/;

export type Env = Record<string, string | undefined>;

/** The config home this process belongs to.
 *
 * `CLAUDE_CONFIG_DIR` is what the harness itself reads, so a session and the
 * instance it talks to agree on which one they mean without ccmsg naming it
 * separately. Nothing searches for another one (M6). */
export function resolveConfigHome(env: Env = process.env): string {
  const named = env["CLAUDE_CONFIG_DIR"];
  if (named !== undefined && named !== "" && isAbsolute(named)) return named;
  return join(home(env), ".claude");
}

/** Resolve everything, given the environment.
 *
 * The three categories follow the XDG base directories, with the instance key
 * as the directory under each: config is what a person edits, state is what
 * survives a restart but costs only convenience if lost (the spec names logs
 * and history there), and the socket / pid / lock are handles that live with
 * the state so a temporary directory sweep cannot take the socket out from
 * under a running instance. */
export function resolvePaths(env: Env = process.env): InstancePaths {
  const configHome = resolveConfigHome(env);
  const key = instanceKey(configHome);
  const configDir = resolveConfigDir(env);
  const stateDir = appDir(env, "CCMSG_STATE_DIR", "XDG_STATE_HOME", [".local", "state"], key);
  const socketDir = socketDirFor(stateDir, key);
  return {
    configHome,
    key,
    configFile: join(configDir, "config.json"),
    stateDir,
    socketDir,
    socket: join(socketDir, SOCKET_NAME),
    socketReal: join(socketDir, realSocketName(process.pid)),
    pluginsDir: join(stateDir, "plugins"),
    pidFile: join(stateDir, "daemon.pid"),
    lockFile: join(stateDir, "daemon.lock"),
    logFile: join(stateDir, "daemon.log"),
    instanceIdFile: join(stateDir, "instance.id"),
  };
}

/** Where the shared config file lives.
 *
 * No instance segment, unlike the state: config is what a person edits, and
 * one file listing every config home is what lets them add an instance without
 * already knowing the key ccmsg would derive for it. */
export function resolveConfigDir(env: Env = process.env): string {
  const direct = env["CCMSG_CONFIG_DIR"];
  if (direct !== undefined && direct !== "") return direct;
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home(env), ".config");
  return join(base, "ccmsg");
}

/** Where things that belong to no single instance keep their state — the
 * supervisor's log above all. The instance segment is what a per-instance state
 * directory adds to this, so this is that path without it. */
export function resolveStateRoot(env: Env = process.env): string {
  const direct = env["CCMSG_STATE_DIR"];
  if (direct !== undefined && direct !== "") return direct;
  const xdg = env["XDG_STATE_HOME"];
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home(env), ".local", "state");
  return join(base, "ccmsg");
}

/** Where the supervisor answers the commands addressed to it.
 *
 * One socket for the host rather than one per instance, because the supervisor
 * is one process for the host: the config homes it looks after are what a
 * request names, not what it connects to. It sits with the state for the reason
 * an instance's socket does — a temporary directory sweep must not take the
 * address out from under a running process — and falls back to the same short
 * per-uid directory when the state path would not fit in `sun_path`. */
export function resolveSupervisorSocket(env: Env = process.env): string {
  const beside = join(resolveStateRoot(env), SUPERVISOR_SOCKET);
  if (Buffer.byteLength(beside) < MAX_SOCKET_PATH) return beside;
  return join("/tmp", `ccmsg-${String(process.getuid?.() ?? 0)}`, SUPERVISOR_SOCKET);
}

export const SUPERVISOR_SOCKET = "supervise.sock";

/** The shared config file, for a caller that has no instance to resolve. */
export function resolveConfigFile(env: Env = process.env): string {
  return join(resolveConfigDir(env), "config.json");
}

/** A name for one config home that is readable and cannot collide.
 *
 * The readable half is the config home's own last segment, which is what a
 * person recognises; the digest is what keeps two homes of the same name under
 * different parents from sharing a socket. */
export function instanceKey(configHome: string): string {
  const digest = createHash("sha256").update(configHome).digest("hex").slice(0, 8);
  const name = basename(configHome).replace(/[^A-Za-z0-9._-]/g, "-") || "home";
  return `${name}-${digest}`;
}

/** The home directory, from the environment the caller handed in, so resolving
 * paths is a function of that environment and a test can resolve for a home
 * that is not this process's. */
function home(env: Env): string {
  const named = env["HOME"];
  return named !== undefined && isAbsolute(named) ? named : homedir();
}

/** The three-step fallback: the app's own variable, then XDG, then the spec's
 * default. The app variable names the directory itself, so a test can put an
 * instance somewhere disposable; the other two get the app and instance
 * segments appended. A relative path in an XDG variable is invalid per the
 * spec and is ignored. */
function appDir(
  env: Env,
  appVar: string,
  xdgVar: string,
  fallback: readonly string[],
  key: string,
): string {
  const direct = env[appVar];
  if (direct !== undefined && direct !== "") return direct;
  const xdg = env[xdgVar];
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home(env), ...fallback);
  return join(base, "ccmsg", key);
}

/** Where the sockets go: beside the state they belong to, unless the longest
 * name that directory would hold does not fit in `sun_path`.
 *
 * The length is judged on the widest real path rather than on the stable one,
 * because the real path is what gets bound and it is the longer of the two.
 * The fallback is a per-uid directory under `/tmp`, short by construction and
 * reached only by a deeply nested state directory. */
function socketDirFor(stateDir: string, key: string): string {
  const widest = join(stateDir, realSocketName(9_999_999));
  if (Buffer.byteLength(widest) < MAX_SOCKET_PATH) return stateDir;
  return join("/tmp", `ccmsg-${process.getuid?.() ?? 0}`, key);
}
