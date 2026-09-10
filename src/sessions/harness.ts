import { type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { AgentInfo, InstanceId, Sid } from "@ccmsg/protocol";
import type { Harness } from "../harness/index.ts";

/** The status the harness writes while a dialog is open and it is waiting for
 * an answer, alongside a `waitingFor` naming what it waits on.
 *
 * Read out of the harness binary (2.1.263): `{status:"waiting",waitingFor:…}`.
 * This is the one thing the raw status decides (§5.1 / DV-Q5) — busy and idle
 * are the gateway's to say, so no other value of it is read here. */
const WAITING = "waiting";

/** How often the confirmation poll re-reads the directory.
 *
 * `fs.watch` is the route; this is not. macOS/Bun delivers FSEvents tens of
 * seconds late under load (measured in the old daemon while many test children
 * ran), and the poll exists so a change the watch is sitting on is picked up
 * before a person notices it is missing (§5.1). Five seconds is the interval
 * the old daemon's `claude agents` poller ran at as its only route, and this
 * one replaces it as a backstop (DV-Q6), so it cannot be the slower of the
 * two. */
export const CONFIRM_POLL_MS = 5_000;

const STATE_FILE = /^\d+\.json$/;

/** Which sessions one harness says exist right now, read from its config home.
 *
 * Two answers rather than one, because the harnesses do not say the same
 * amount. Claude Code writes a file per session carrying its pid, its working
 * directory and what it is doing, which is the shape the contract's `AgentInfo`
 * states and what the `agents` topic is; Codex says only that a thread has a
 * live writer, which answers "is it there" and nothing else. So `rows` is what
 * can be reported and `present` is what the classification reads, and a harness
 * that reports nothing still has its sessions classified (§5.1). */
export interface OwnSessions {
  readonly running: boolean;
  /** Begins watching. Called when the first subscriber arrives and not before
   * (§6.3 / §8.3: no upstream is read until somebody is listening). */
  start(): void;
  stop(): void;
  /** The harness's own rows, as `agents` answers with them. Empty for a
   * harness whose own view is not the one that contract states. */
  rows(): ReadonlyMap<Sid, AgentInfo>;
  /** The sessions the harness says are there at this instant. */
  present(): ReadonlySet<Sid>;
}

/** The one this config home runs (§3.8). */
export function ownSessions(
  harness: Harness,
  configHome: string,
  instance: InstanceId,
  onChange: () => void,
  pollMs?: number,
): OwnSessions {
  return harness === "codex"
    ? new CodexThreads(join(configHome, CODEX_LOCKS), onChange, pollMs)
    : new HarnessSessions(join(configHome, "sessions"), instance, onChange, pollMs);
}

/** Where the Codex thread store takes a lock while a thread has a live writer,
 * and what one of those locks is called.
 *
 * Measured against codex-cli 0.153.4: the file appears under this directory
 * while a thread is being written and is gone once the process that had it
 * ends normally. The `.coordination.lock` beside them belongs to the store's
 * own cleanup and names no thread, which the shape below excludes.
 *
 * A process killed outright leaves its lock behind (measured), so a thread
 * whose session died without a word reads as present until Codex itself sweeps
 * the stale lock. That is the same direction as the state file Claude Code
 * leaves behind — except that a lock names no pid, so there is nothing here to
 * ask whether anybody still holds it. */
const CODEX_LOCKS = "thread-writer-locks";
const THREAD_LOCK = /^([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.lock$/;

/** The Codex threads with a live writer, read from one config home.
 *
 * It reports no rows: `AgentInfo` is Claude Code's own list (contract), and a
 * lock file carries none of what that shape states. What a Codex session is —
 * where it works, what it is called — is what it said when it greeted, and
 * that is held by the registry for every harness alike. */
class CodexThreads implements OwnSessions {
  readonly #watch: DirectoryWatch;

  constructor(dir: string, onChange: () => void, pollMs?: number) {
    this.#watch = new DirectoryWatch(dir, onChange, pollMs);
  }

  get running(): boolean {
    return this.#watch.running;
  }

  start(): void {
    this.#watch.start();
  }

  stop(): void {
    this.#watch.stop();
  }

  rows(): ReadonlyMap<Sid, AgentInfo> {
    return new Map();
  }

  present(): ReadonlySet<Sid> {
    const live = new Set<Sid>();
    for (const name of this.#watch.names()) {
      const sid = THREAD_LOCK.exec(name)?.[1];
      if (sid !== undefined) live.add(sid);
    }
    return live;
  }
}

/** The sessions the harness itself reports, read from one config home.
 *
 * The directory is the whole input: it says which sessions exist and which is
 * waiting on a dialog (§5.1). Only the config home this instance was given is
 * ever opened (M6) — the path is handed in, and nothing here searches for
 * another one.
 *
 * Two things live here, and §6.3 separates them. Reading the directory answers
 * a question, and is done whenever one is asked. Watching it says the answer
 * may have changed, which is only worth knowing while somebody is subscribed —
 * so the watch is what the subscription drives, and no answer waits on it. */
export class HarnessSessions implements OwnSessions {
  readonly #watch: DirectoryWatch;
  readonly #lastComplete = new Map<string, AgentInfo>();

  constructor(
    private readonly dir: string,
    private readonly instance: InstanceId,
    onChange: () => void,
    pollMs?: number,
  ) {
    this.#watch = new DirectoryWatch(dir, onChange, pollMs);
  }

  get running(): boolean {
    return this.#watch.running;
  }

  start(): void {
    this.#watch.start();
  }

  stop(): void {
    this.#watch.stop();
  }

  rows(): ReadonlyMap<Sid, AgentInfo> {
    return this.scan();
  }

  /** Every session with a state file, which for this harness is the same
   * reading its rows came from. */
  present(): ReadonlySet<Sid> {
    return new Set(this.scan().keys());
  }

  /** The directory as it is at this instant.
   *
   * Every answer comes from here rather than from anything the watch left
   * behind. Which sessions exist is an input to the classification (§5.1), and
   * classifying happens inside `message_send`'s decision and inside the
   * recompute that writes `last_live` — neither of which can hand back a
   * promise without changing what it means, and neither of which may depend on
   * somebody being subscribed. The ops that signal a session's process read it
   * here too: a pid from a poll that has not run is a number belonging to
   * nobody.
   *
   * Read in place because the directory is a handful of small files of this
   * uid's own config home (M6) — a syscall or two per session, not a wait. */
  scan(): ReadonlyMap<Sid, AgentInfo> {
    const rows = new Map<Sid, AgentInfo>();
    const names = this.#watch.names().filter((name) => STATE_FILE.test(name));
    const present = new Set(names);
    for (const name of names) {
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
      } catch {
        const previous = this.#lastComplete.get(name);
        if (previous !== undefined) rows.set(previous.sid, previous);
        continue;
      }
      const result = toRow(document, this.dir, this.instance);
      if (!result.complete) {
        const previous = this.#lastComplete.get(name);
        if (previous !== undefined) rows.set(previous.sid, previous);
        continue;
      }
      if (result.row === undefined) {
        this.#lastComplete.delete(name);
        continue;
      }
      this.#lastComplete.set(name, result.row);
      rows.set(result.row.sid, result.row);
    }
    for (const name of this.#lastComplete.keys()) {
      if (!present.has(name)) this.#lastComplete.delete(name);
    }
    return rows;
  }
}

/** One directory that says what the harness's sessions are, watched while
 * somebody is subscribed and read whenever an answer is wanted.
 *
 * The two things §6.3 separates live here. Reading the directory answers a
 * question, and is done whenever one is asked. Watching it says the answer may
 * have changed, which is only worth knowing while somebody is listening — so
 * the watch is what the subscription drives, and no answer waits on it. */
class DirectoryWatch {
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
    private readonly pollMs: number = CONFIRM_POLL_MS,
  ) {}

  get running(): boolean {
    return this.#watcher !== undefined || this.#timer !== undefined;
  }

  start(): void {
    if (this.running) return;
    try {
      this.#watcher = watch(this.dir, this.onChange);
    } catch {
      // The directory does not exist yet — a config home whose harness has not
      // run. The poll below both covers the wait and picks it up when it
      // appears, so this is not a failure to start.
      this.#watcher = undefined;
    }
    this.#timer = setInterval(this.onChange, this.pollMs);
    this.onChange();
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** What is in the directory now. Read in place because it is a handful of
   * small entries of this uid's own config home (M6) — a syscall or two, not a
   * wait. */
  names(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }
}

/** Whether the harness says this session is waiting on a dialog. */
export function isWaiting(row: AgentInfo): boolean {
  return row.status === WAITING;
}

/** A syntactically complete state document, and the row it states when its
 * process is still alive. A complete document for a dead process is distinct
 * from a document caught between truncate and write: only the latter keeps the
 * last complete row while the writer finishes. */
type RowResult =
  | { readonly complete: false }
  | { readonly complete: true; readonly row?: AgentInfo };

/** The conversion of one upstream document into the contract's spelling
 * (§3.5): renamed to snake_case, instants in Unix ms, and nothing carried over
 * that the contract does not name.
 *
 * A row whose process is gone is dropped: the file outlives a session that did
 * not clean up after itself, and "the session exists" is what this input is
 * for. */
function toRow(document: unknown, configDir: string, instance: InstanceId): RowResult {
  if (typeof document !== "object" || document === null) return { complete: false };
  const raw = document as Record<string, unknown>;
  const sid = text(raw["sessionId"]);
  const pid = raw["pid"];
  const cwd = text(raw["cwd"]);
  const kind = text(raw["kind"]);
  const startedAt = raw["startedAt"];
  if (sid === undefined || cwd === undefined || kind === undefined) return { complete: false };
  if (typeof pid !== "number" || typeof startedAt !== "number") return { complete: false };
  if (!alive(pid)) return { complete: true };
  return {
    complete: true,
    row: {
      sid,
      instance,
      pid,
      cwd,
      kind,
      started_at: startedAt,
      config_dir: configDir,
      ...optional("name", text(raw["name"])),
      ...optional("status", text(raw["status"])),
      ...optional("waiting_for", text(raw["waitingFor"])),
      ...optional("state", text(raw["state"])),
      ...optional("background_id", text(raw["backgroundId"])),
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // EPERM would mean alive but ours to signal — impossible here, since the
    // daemon and the sessions of its config home run as one uid (§2 A4).
    return false;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}
