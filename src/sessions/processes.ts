import type { AgentInfo, Sid } from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";

/** How long a child this instance runs to observe a process may take. A wedged
 * reader must not hold a request open; the answer it would have given is worth
 * less than the connection it would hold. */
const CHILD_TIMEOUT_MS = 5_000;

/** The two-shot termination of a session, in the intervals it was measured at.
 *
 * The harness's first SIGTERM only arms its quit confirmation, so a second is
 * sent to a process that is still there a second later. Nothing escalates to
 * SIGKILL on its own: an unconditional kill forfeits the session's chance to
 * flush its transcript, which the contract says a caller asks for after
 * watching a graceful attempt go unconfirmed. */
export const SECOND_SIGNAL_AFTER_MS = 1_000;
export const GRACE_MS = 3_000;
/** How often the process is asked whether it is still there.
 *
 * The confirmation is not observable any other way: a process's own exit is
 * reported to its parent, and this instance is not one. Polling `kill(pid, 0)`
 * is the route the platform leaves, and the interval bounds how long a
 * finished kill reads as unconfirmed. */
export const LIVENESS_POLL_MS = 200;

/** What acting on a session's process needs from the world around it.
 *
 * Every effect is injectable because the alternative is a test that signals
 * real processes: the rows come from the harness's own directory, the signal
 * and the liveness probe are the platform's, and the two readers are children.
 */
export interface ProcessDeps {
  /** The harness's sessions, read now rather than from a watch's cache. Only
   * this instance's config home is ever read (M6). */
  readonly rows: () => ReadonlyMap<Sid, AgentInfo>;
  /** What the process is running, as `ps` states argv. */
  readonly command: (pid: number) => Promise<string>;
  /** The process's own environment, as the platform exposes it. */
  readonly environment: (pid: number) => Promise<string>;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly alive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly platform: () => NodeJS.Platform;
  /** What a rename types with, when this instance has one configured. */
  readonly type?: (terminal: Terminal, keys: readonly string[]) => Promise<void>;
}

/** The terminal a session runs in, as its own process names it. */
export interface Terminal {
  readonly id: string;
  /** Absent means the process set none, which the multiplexer reads as its own
   * default — not this instance's namespace, which can differ. */
  readonly namespace?: string;
}

/** The environment variables a session's terminal is named by. */
const TERMINAL_ID = "HYOUI_SESSION_ID";
const TERMINAL_NAMESPACE = "HYOUI_NAMESPACE";

/** The ops that act on the process behind a session.
 *
 * The subject is always resolved sid → pid here, at the moment of acting: a
 * pid a caller asserted would be a weaker basis for killing something, and a
 * pid resolved seconds ago may since have been recycled. What guards the
 * recycling is the same check for all three ops — a pid whose process is no
 * longer the harness is one this instance does not act on, and says so as the
 * session not being there. */
export class SessionProcesses {
  constructor(private readonly deps: ProcessDeps) {}

  /** The pid behind a session, checked to still be that session's.
   *
   * A row this instance's config home does not hold is a session not found,
   * whether it belongs to another config home or to nothing: this instance
   * answers for one config home (M6), and a pid read from anywhere else is a
   * number it has no business signalling. */
  async pid(sid: Sid): Promise<number> {
    const rows = this.deps.rows();
    const row = rows.get(sid);
    // A pid at or below 1 is refused before it reaches a signal: 0 addresses
    // this process's own group and a negative number a whole group, so a
    // corrupted row must not be able to reach either.
    if (row === undefined || !Number.isInteger(row.pid) || row.pid <= 1) {
      throw new OpError("session_not_found", `${sid} is no session of this instance`);
    }
    if (!(await this.isHarness(row.pid))) {
      throw new OpError("session_not_found", `the process of ${sid} is gone`);
    }
    return row.pid;
  }

  /** End the process behind a session. `terminated` reports whether it was
   * seen to go, which is false rather than an error when the signals were
   * delivered and the process was still there. */
  async kill(sid: Sid, force = false): Promise<{ terminated: boolean }> {
    const pid = await this.pid(sid);
    const first = force ? "SIGKILL" : "SIGTERM";
    if (this.send(pid, first)) return { terminated: true };
    let waited = 0;
    let repeated = force;
    while (waited < GRACE_MS) {
      await this.deps.sleep(LIVENESS_POLL_MS);
      waited += LIVENESS_POLL_MS;
      if (!this.deps.alive(pid)) return { terminated: true };
      if (!repeated && waited >= SECOND_SIGNAL_AFTER_MS) {
        repeated = true;
        if (this.send(pid, "SIGTERM")) return { terminated: true };
      }
    }
    return { terminated: !this.deps.alive(pid) };
  }

  /** The environment of the session's own process.
   *
   * Read from the resolved pid rather than from the connection the session
   * speaks on: the helper holding that connection carries a different
   * environment than the session itself. */
  async environment(sid: Sid): Promise<{ pid: number; env: Record<string, string> }> {
    const pid = await this.pid(sid);
    let raw: string;
    try {
      raw = await this.deps.environment(pid);
    } catch (cause) {
      throw new OpError(
        "not_found",
        `the environment of ${sid} could not be read: ${String(cause)}`,
      );
    }
    return { pid, env: parseEnvironment(raw, this.deps.platform()) };
  }

  /** The terminal a session runs in, as its own process names it.
   *
   * Read from the running process rather than remembered from when it started:
   * resuming a session gives it a new process, in whatever terminal that one
   * runs in. */
  async terminal(sid: Sid): Promise<Terminal> {
    const { env } = await this.environment(sid);
    const id = env[TERMINAL_ID];
    if (id === undefined || id === "") {
      throw new OpError("not_found", `${sid} names no terminal to type into`);
    }
    const namespace = env[TERMINAL_NAMESPACE];
    return { id, ...(namespace === undefined || namespace === "" ? {} : { namespace }) };
  }

  /** Type into a session's terminal. */
  async type(terminal: Terminal, keys: readonly string[]): Promise<void> {
    const send = this.deps.type;
    if (send === undefined) {
      throw new OpError("capability_unavailable", "this instance types into no terminal");
    }
    await send(terminal, keys);
  }

  /** Whether the pid still belongs to the harness.
   *
   * The guard against a recycled pid, and the only thing standing between a
   * stale row and a signal sent to an unrelated process. It compares what the
   * process was launched as rather than searching its command line for a word:
   * on a host running sessions, half the processes carry the harness's name
   * somewhere in their arguments, including this instance. */
  private async isHarness(pid: number): Promise<boolean> {
    let command: string;
    try {
      command = await this.deps.command(pid);
    } catch {
      // `ps` failing includes the pid being gone, which is the same outcome for
      // every caller: there is no process of this session to act on.
      return false;
    }
    return executable(command) === HARNESS;
  }

  /** Send one signal. Answers whether the process was already gone, which is
   * what the caller wanted; any other failure is not this op's to interpret. */
  private send(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    try {
      this.deps.signal(pid, signal);
      return false;
    } catch (cause) {
      if (isGone(cause)) return true;
      throw cause;
    }
  }
}

/** The command a session runs as. */
const HARNESS = "claude";

/** The last segment of the first word of a command line: what the process was
 * launched as, however it was found on the path. */
function executable(command: string): string {
  const argv0 = command.trimStart().split(/\s/, 1)[0] ?? "";
  return argv0.slice(argv0.lastIndexOf("/") + 1);
}

/** The pid is gone. The one signalling failure that means the caller's goal
 * was already met — every other one (notably being refused permission on a
 * process that is demonstrably there) must not read as a confirmed kill. */
function isGone(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ESRCH"
  );
}

/** A process environment, in the shape its platform states it.
 *
 * Linux writes NUL-separated `KEY=VALUE` records, which is unambiguous: a
 * value holding spaces, newlines or `=` survives whole. macOS prints the
 * environment space-separated after the command line with no quoting at all,
 * so a value holding a space cannot be told from the next variable by
 * splitting alone — a token is read as a new variable only when it looks like
 * an assignment, and anything else continues the value before it. That
 * reconstructs spaced values except where one contains a token that itself
 * reads as an assignment, which is the format's own ambiguity rather than a
 * choice made here. */
export function parseEnvironment(raw: string, platform: NodeJS.Platform): Record<string, string> {
  return platform === "linux" ? parseRecords(raw) : parseColumns(raw);
}

/** A variable name as POSIX states one, anchored to a whole token's key part. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function parseRecords(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const record of raw.split("\0")) {
    const at = record.indexOf("=");
    // A record with no name is not an assignment; skipping beats inventing an
    // entry with an empty name.
    if (at <= 0) continue;
    env[record.slice(0, at)] = record.slice(at + 1);
  }
  return env;
}

function parseColumns(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  let key: string | undefined;
  for (const token of raw.trim().split(/\s+/)) {
    if (ASSIGNMENT.test(token)) {
      const at = token.indexOf("=");
      key = token.slice(0, at);
      env[key] = token.slice(at + 1);
      continue;
    }
    // Everything before the first assignment is the command line, and
    // everything after one that is not itself an assignment is the rest of a
    // value `ps` collapsed a separator inside.
    if (key !== undefined) env[key] += ` ${token}`;
  }
  return env;
}

/** Run one child and take its output.
 *
 * Both pipes are drained together: a child writing more than a pipe holds to
 * one nobody reads never exits, and an environment is easily that large. */
export async function run(argv: string[], timeoutMs = CHILD_TIMEOUT_MS): Promise<string> {
  const child = Bun.spawn(argv, {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [code, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${error.trim().slice(0, 200)}`);
  return out;
}

/** The effects as this host provides them. */
export function hostProcessDeps(
  rows: () => ReadonlyMap<Sid, AgentInfo>,
  terminalCommand?: string,
): ProcessDeps {
  return {
    rows,
    command: (pid) => run(["ps", "-p", String(pid), "-o", "command="]),
    environment: (pid) =>
      process.platform === "linux"
        ? Bun.file(`/proc/${pid}/environ`).text()
        : run(["ps", "eww", "-p", String(pid), "-o", "command="]),
    signal: (pid, signal) => {
      process.kill(pid, signal);
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause) {
        // Being refused permission means the process is there and not ours to
        // signal, which is not the same as gone.
        return !isGone(cause);
      }
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    platform: () => process.platform,
    ...(terminalCommand === undefined
      ? {}
      : {
          type: async (terminal: Terminal, keys: readonly string[]) => {
            await run([
              terminalCommand,
              "input",
              ...(terminal.namespace === undefined ? [] : ["--namespace", terminal.namespace]),
              terminal.id,
              ...keys,
            ]);
          },
        }),
  };
}
