import { HYOUI_TERMINAL_SCHEME, type SessionRun, type Sid, type Timestamp } from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import { isHarness, launchedAs } from "../harness/index.ts";
import { managerOf, terminalId } from "../terminals/ids.ts";
import type { TerminalReader } from "./terminals.ts";

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

/** How far apart the row's `startedAt` and the process's own start time may be
 * and still be one process, in each direction.
 *
 * The two are different events: the process starts, and the harness writes the
 * row once it has come up. So the process is the earlier of the two by however
 * long that took, which a session that waits on a prompt before writing its
 * row can stretch to a minute; and it is later than the row only by
 * measurement error, which is `ps` stating how long the process has been
 * running truncated to the second.
 *
 * A recycled pid is nowhere near either bound: its process began after the
 * row's process exited, which is the whole life of a session later. */
export const STARTED_BEFORE_TOLERANCE_MS = 120_000;
export const STARTED_AFTER_TOLERANCE_MS = 5_000;

/** Whether a process that began at `started` is the one a row stating
 * `startedAt` was written for, within the tolerances above.
 *
 * The one comparison, in one place: the ops that signal a process make it
 * before they act, and the reading of the harness's directory makes it before
 * it calls a state file's pid a run (`StartCache`). Two spellings of it would
 * be two answers about the same pid. */
export function sameProcess(started: Timestamp, startedAt: Timestamp): boolean {
  const after = started - startedAt;
  return after <= STARTED_AFTER_TOLERANCE_MS && -after <= STARTED_BEFORE_TOLERANCE_MS;
}

/** What acting on a session's process needs from the world around it.
 *
 * Every effect is injectable because the alternative is a test that signals
 * real processes: the rows come from the harness's own directory, the signal
 * and the liveness probe are the platform's, and the two readers are children.
 */
export interface ProcessDeps {
  /** The runs of one session, read now rather than from the last reading of
   * the directory. Only this instance's config home is ever read (M6). */
  readonly runs: (sid: Sid) => Promise<readonly SessionRun[]>;
  /** What the process is running, as `ps` states argv. */
  readonly command: (pid: number) => Promise<string>;
  /** The process's own environment, as the platform exposes it. */
  readonly environment: (pid: number) => Promise<string>;
  /** When the process was started, as the platform states it. Undefined when
   * the platform stated something this instance could not read as an instant. */
  readonly started: (pid: number) => Promise<Timestamp | undefined>;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly alive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly platform: () => NodeJS.Platform;
  /** What a rename types with. Refuses a terminal no manager here can act on,
   * which is the same answer whether this host has no manager at all or the
   * terminal belongs to one it does not speak to. */
  readonly type?: (terminal: Terminal, keys: readonly string[]) => Promise<void>;
}

/** The terminal a session runs in, as its own process names it.
 *
 * The id is the one the wire states and the `terminals` list holds
 * (`<scheme>:<handle>`), so a terminal reached through a session and the same
 * terminal on that list are one value rather than two spellings of one. What
 * acts on it reads the manager out of the scheme (`managerOf`). */
export interface Terminal {
  readonly id: string;
  /** Absent means the process set none, which the multiplexer reads as its own
   * default — not this instance's namespace, which can differ. */
  readonly namespace?: string;
}

/** The environment variables a session's terminal is named by. */
const TERMINAL_ID = "HYOUI_SESSION_ID";
const TERMINAL_NAMESPACE = "HYOUI_NAMESPACE";

/** The terminal an environment names, or nothing when it names none.
 *
 * The variable carries the manager's own handle, and which manager set it is
 * the variable itself — so the scheme is put on here, where that is known,
 * rather than by each use working it out again. */
export function terminalOf(env: Record<string, string>): Terminal | undefined {
  const handle = env[TERMINAL_ID];
  if (handle === undefined || handle === "") return undefined;
  const namespace = env[TERMINAL_NAMESPACE];
  return {
    id: terminalId(HYOUI_TERMINAL_SCHEME, handle),
    ...(namespace === undefined || namespace === "" ? {} : { namespace }),
  };
}

/** The ops that act on the process behind a session.
 *
 * The subject is resolved to a pid here, at the moment of acting, against the
 * session's own runs: a pid resolved seconds ago may since have been recycled,
 * and one a caller asserted is checked against what the session actually has
 * rather than taken on trust (contract, `SessionKillArgs.pid`). What guards the
 * recycling is the same check for all three ops — a pid whose process is no
 * longer the harness is one this instance does not act on, and says so as the
 * session not being there. */
export class SessionProcesses {
  constructor(private readonly deps: ProcessDeps) {}

  /** The run of a session a caller named, or its only one.
   *
   * A session with two runs cannot be resolved from the sid alone, and the ops
   * that could act on either of them differ in what they can say about it: a
   * kill is refused with `ambiguous_run` so a person picks one from
   * `peers.runs`, while reading an environment or typing a rename has no such
   * code to answer with and takes the run that started first — a deterministic
   * choice rather than whichever file was read last (contract DR-0001 §3).
   *
   * A run with no pid is not one of these: nothing in this contract can signal
   * a run known only by its connection. */
  async #run(sid: Sid, wanted: number | undefined, ambiguous: boolean): Promise<SessionRun> {
    const runs = (await this.deps.runs(sid))
      // A pid at or below 1 is refused before it reaches a signal: 0 addresses
      // this process's own group and a negative number a whole group, so a
      // corrupted row must not be able to reach either.
      .filter((run) => run.pid !== undefined && Number.isInteger(run.pid) && run.pid > 1)
      .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
    if (wanted !== undefined) {
      const named = runs.find((run) => run.pid === wanted);
      if (named === undefined) {
        throw new OpError("session_not_found", `${wanted} is no run of ${sid}`);
      }
      return named;
    }
    if (ambiguous && runs.length >= 2) {
      throw new OpError(
        "ambiguous_run",
        `${sid} has ${runs.length} runs, so name the pid of the one to act on`,
      );
    }
    const only = runs[0];
    if (only === undefined) {
      throw new OpError("session_not_found", `${sid} is no session of this instance`);
    }
    return only;
  }

  /** The pid behind a session, checked to still be that session's.
   *
   * A session this instance's config home does not hold is a session not found,
   * whether it belongs to another config home or to nothing: this instance
   * answers for one config home (M6), and a pid read from anywhere else is a
   * number it has no business signalling. */
  async pid(sid: Sid, wanted?: number, ambiguous = false): Promise<number> {
    const run = await this.#run(sid, wanted, ambiguous);
    const pid = run.pid as number;
    if (!(await this.isHarness(pid))) {
      throw new OpError("session_not_found", `the process of ${sid} is gone`);
    }
    if (run.started_at !== undefined && !(await this.isSameProcess(pid, run.started_at))) {
      throw new OpError("session_not_found", `the process of ${sid} is gone`);
    }
    return pid;
  }

  /** End one run of a session. `terminated` reports whether it was seen to go,
   * which is false rather than an error when the signals were delivered and the
   * process was still there.
   *
   * The pid, where the caller named one, is looked for among the session's own
   * runs before anything is signalled: a pid the caller got wrong ends nothing
   * rather than ending whatever the OS has since given that number to. */
  async kill(sid: Sid, force = false, wanted?: number): Promise<{ terminated: boolean }> {
    const pid = await this.pid(sid, wanted, true);
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
    const terminal = terminalOf(env);
    if (terminal === undefined) {
      throw new OpError("not_found", `${sid} names no terminal to type into`);
    }
    return terminal;
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
    return isHarness(launchedAs(command));
  }

  /** Whether the process running under the pid now is the one the row was
   * written for.
   *
   * The second half of the recycling guard, and the half that catches what
   * argv0 cannot: a pid recycled onto another session of the same harness is a
   * process the argv0 check accepts. What separates them is when they started
   * — a recycled pid belongs to a process that began after the row was
   * written, since the pid was not free until the row's own process had
   * exited.
   *
   * A start time the host stated in a form this instance could not read leaves
   * the pid on the argv0 check alone. Refusing instead would make the ops
   * unusable on such a host, which is a certain loss against the one this
   * guards. */
  private async isSameProcess(pid: number, startedAt: Timestamp): Promise<boolean> {
    let started: Timestamp | undefined;
    try {
      started = await this.deps.started(pid);
    } catch {
      return true;
    }
    if (started === undefined) return true;
    return sameProcess(started, startedAt);
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

/** The environment of one process, as this host exposes it: a file on Linux,
 * and only `ps` on macOS. */
function hostEnvironment(pid: number): Promise<string> {
  return process.platform === "linux"
    ? Bun.file(`/proc/${pid}/environ`).text()
    : run(["ps", "eww", "-p", String(pid), "-o", "command="]);
}

/** When one process started, as this host states it.
 *
 * Asked for as the time it has been running rather than as the instant it
 * began: `ps` prints an instant in local time with no zone on it, which a
 * reader in another zone — a daemon started under one, a test run under UTC —
 * turns into an instant hours away. Elapsed time carries no zone at all.
 *
 * The format is `[[dd-]hh:]mm:ss`, and its resolution is the second, which is
 * why the guard that compares it allows for one. */
export async function hostStarted(pid: number): Promise<Timestamp | undefined> {
  const elapsed = elapsedSeconds((await run(["ps", "-p", String(pid), "-o", "etime="])).trim());
  return elapsed === undefined ? undefined : Date.now() - elapsed * 1000;
}

/** `[[dd-]hh:]mm:ss` in seconds. Undefined for anything else, which is a host
 * whose `ps` states elapsed time in some other form. */
export function elapsedSeconds(etime: string): number | undefined {
  const [days, clock] = etime.includes("-") ? etime.split("-", 2) : [undefined, etime];
  const parts = (clock ?? "").split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const numbers = [...(days === undefined ? [] : [days]), ...parts].map(Number);
  if (numbers.some((part) => !Number.isInteger(part) || part < 0)) return undefined;
  // Seconds are last whatever was stated before them, so the units are read
  // from the end: seconds, minutes, hours, days.
  return numbers
    .reverse()
    .reduce((total, part, at) => total + part * [1, 60, 3600, 86_400][at]!, 0);
}

/** The reader the terminal cache is filled through, as this host provides it. */
export function hostTerminalReader(): TerminalReader {
  return async (pid) => terminalOf(parseEnvironment(await hostEnvironment(pid), process.platform));
}

/** The effects as this host provides them. */
export function hostProcessDeps(runs: (sid: Sid) => Promise<readonly SessionRun[]>): ProcessDeps {
  return {
    runs,
    command: (pid) => run(["ps", "-p", String(pid), "-o", "command="]),
    environment: hostEnvironment,
    started: hostStarted,
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
    // Which command types into a terminal is the terminal's own to say: its
    // scheme names the manager that observed it, and only that manager knows
    // the handle behind it (contract, DR-0026). What is typed goes to that
    // command under the handle, never under the id the wire states — the
    // scheme is this instance's way of telling managers apart, and means
    // nothing to the manager itself.
    type: async (terminal: Terminal, keys: readonly string[]) => {
      const manager = managerOf(terminal.id);
      if (manager === undefined) {
        throw new OpError(
          "capability_unavailable",
          `${terminal.id} is a terminal this instance types into no manager of`,
        );
      }
      await run([
        manager.command,
        "input",
        ...(terminal.namespace === undefined ? [] : ["--namespace", terminal.namespace]),
        manager.handle,
        ...keys,
      ]);
    },
  };
}
