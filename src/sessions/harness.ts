import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInfo, InstanceId, Sid } from "@ccmsg/protocol";
import type { Harness } from "../harness/index.ts";
import { DirectoryWatch } from "./watch.ts";

/** The status the harness writes while a dialog is open and it is waiting for
 * an answer, alongside a `waitingFor` naming what it waits on.
 *
 * Read out of the harness binary (2.1.263): `{status:"waiting",waitingFor:…}`.
 * This is the one thing the raw status decides (DESIGN §4.2 / DR-0009) — busy and idle
 * are the gateway's to say, so no other value of it is read here. */
const WAITING = "waiting";

/** How often the confirmation poll re-reads the directory.
 *
 * `fs.watch` is the route; this is not. A session started by any route at all —
 * this instance's launcher, a person's own shell, anything that runs the
 * harness — is a session this instance must come to know about, and not
 * everything that makes the directory's answer change is a change to the
 * directory: a process that died leaves its state file behind, so the row it
 * states goes away with no event to say so. The poll is what re-reads
 * regardless (DESIGN §4.2). Five seconds is the interval the old daemon's
 * `claude agents` poller ran at as its only route, and this one replaces it as
 * a backstop (DR-0009), so it cannot be the slower of the two. */
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
 * that reports nothing still has its sessions classified (DESIGN §4.2). */
export interface OwnSessions {
  readonly running: boolean;
  /** Begins watching. Called when the first subscriber arrives and not before
   * (DESIGN §6.3 / §8.3: no upstream is read until somebody is listening). */
  start(): void;
  stop(): void;
  /** Read the directory again, and settle what the two answers below state.
   *
   * What everything else here answers is the last reading, which is what lets
   * those answers be synchronous. Whoever has to act on the directory as it is
   * at this instant — the ops that signal a session's process — waits for this
   * first, and a reading that began before the question is never what it is
   * answered with. */
  read(): Promise<void>;
  /** The harness's own rows, as `agents` answers with them, keyed by the pid
   * each one is about. Empty for a harness whose own view is not the one that
   * contract states.
   *
   * One process per row: the same session may have two of them, and a row is
   * matched by its pid for that reason (contract, `AgentInfo`). */
  rows(): ReadonlyMap<number, AgentInfo>;
  /** The sessions the harness says are there, as the last reading found them. */
  present(): ReadonlySet<Sid>;
}

/** One directory read over and over, where the answer is the latest reading.
 *
 * The readings overlap: a watch callback, the poll and a question of the
 * directory each start one, and they land in whatever order the filesystem
 * answers in. What settles is the one that began last, so a reading overtaken
 * while it was in flight is dropped rather than written over the newer answer
 * (DR-0015 §2.5). A caller waiting on `again()` is waiting for what the
 * directory holds now: either its own reading settles, or a reading that began
 * after it did, and it waits for that one instead. */
export class Readings<T> {
  #generation = 0;
  #latest: Promise<void> = Promise.resolve();

  constructor(
    private readonly read: () => Promise<T>,
    /** What the reading found, for the one reading that is still the latest
     * when it lands. */
    private readonly settle: (found: T) => void,
  ) {}

  again(): Promise<void> {
    const generation = ++this.#generation;
    const reading = this.#take(generation);
    this.#latest = reading;
    return reading;
  }

  async #take(generation: number): Promise<void> {
    const found = await this.read();
    if (generation !== this.#generation) {
      await this.#latest;
      return;
    }
    this.settle(found);
  }
}

/** The one this config home runs (DESIGN §4.1). */
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
  readonly #readings: Readings<string[]>;
  #present: ReadonlySet<Sid>;

  constructor(dir: string, onChange: () => void, pollMs?: number) {
    this.#watch = new DirectoryWatch(dir, () => void this.read(), pollMs ?? CONFIRM_POLL_MS);
    this.#readings = new Readings(
      () => this.#watch.names(),
      (names) => {
        this.#present = threads(names);
        onChange();
      },
    );
    this.#present = threads(this.#watch.namesNow());
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

  read(): Promise<void> {
    return this.#readings.again();
  }

  rows(): ReadonlyMap<number, AgentInfo> {
    return new Map();
  }

  present(): ReadonlySet<Sid> {
    return this.#present;
  }
}

/** The threads named by the lock files among a directory's entries. */
function threads(names: readonly string[]): ReadonlySet<Sid> {
  const live = new Set<Sid>();
  for (const name of names) {
    const sid = THREAD_LOCK.exec(name)?.[1];
    if (sid !== undefined) live.add(sid);
  }
  return live;
}

/** The sessions the harness itself reports, read from one config home.
 *
 * The directory is the whole input: it says which sessions exist and which is
 * waiting on a dialog (DESIGN §4.2). Only the config home this instance was given is
 * ever opened (M6) — the path is handed in, and nothing here searches for
 * another one.
 *
 * Two things live here, and DESIGN §6.3 separates them. Reading the directory
 * settles what this says, and is done whenever the answer may have moved.
 * Watching it says the answer may have moved, which is only worth knowing while
 * somebody is subscribed — so the watch is what the subscription drives, and no
 * answer waits on it. */
export class HarnessSessions implements OwnSessions {
  readonly #watch: DirectoryWatch;
  readonly #readings: Readings<readonly State[]>;
  #lastComplete: ReadonlyMap<string, AgentInfo>;
  #rows: ReadonlyMap<number, AgentInfo>;

  constructor(
    private readonly dir: string,
    private readonly instance: InstanceId,
    onChange: () => void,
    pollMs?: number,
  ) {
    this.#watch = new DirectoryWatch(dir, () => void this.read(), pollMs ?? CONFIRM_POLL_MS);
    this.#readings = new Readings(
      () => this.#read(),
      (states) => {
        this.#settle(states);
        onChange();
      },
    );
    // The first reading is made here, before this instance holds a connection
    // and so with nobody to be held up by it (DR-0015 §2.4). Every reading
    // after it is the asynchronous one.
    this.#lastComplete = new Map();
    this.#rows = new Map();
    this.#settle(this.#readNow());
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

  read(): Promise<void> {
    return this.#readings.again();
  }

  /** What the state files said when they were last read.
   *
   * Which sessions exist is an input to the classification (DESIGN §4.2), and
   * classifying happens inside `message.send`'s decision and inside the
   * recompute that writes `last_live` — neither of which can hand back a
   * promise without changing what it means, and neither of which may depend on
   * somebody being subscribed. So the reading and the answer are separate
   * things: the directory is read asynchronously, and what it said is stated
   * here in place.
   *
   * Keyed by pid and not by sid: the harness lets a running session be resumed,
   * and from that moment two files name the same session. Folding them onto the
   * sid would keep whichever was read last and leave the duplicate invisible,
   * which is the one thing a client has to be able to see (contract DR-0001). */
  rows(): ReadonlyMap<number, AgentInfo> {
    return this.#rows;
  }

  /** Every session with a state file, which for this harness is the same
   * reading its rows came from. Two state files naming one session are two
   * runs of it and one entry here: this answers which sessions exist, and a
   * session exists once however many processes are writing it. */
  present(): ReadonlySet<Sid> {
    const sids = new Set<Sid>();
    for (const row of this.#rows.values()) {
      if (row.sid !== undefined) sids.add(row.sid);
    }
    return sids;
  }

  /** The directory and every state file in it, read one after another so that
   * a home with many sessions yields between them (DR-0015 §2). */
  async #read(): Promise<readonly State[]> {
    const states: State[] = [];
    for (const name of stateFiles(await this.#watch.names())) {
      states.push({ name, text: await contents(join(this.dir, name)) });
    }
    return states;
  }

  #readNow(): readonly State[] {
    return stateFiles(this.#watch.namesNow()).map((name) => ({
      name,
      text: contentsNow(join(this.dir, name)),
    }));
  }

  /** What one reading found, taken as what this now states.
   *
   * A file caught between truncate and write keeps the last complete row it
   * had, so what a reading carries forward is decided against the reading
   * before it — and a file the directory no longer holds carries nothing
   * forward, which is what keeps this the size of the session list. */
  #settle(states: readonly State[]): void {
    const rows = new Map<number, AgentInfo>();
    const complete = new Map<string, AgentInfo>();
    for (const { name, text } of states) {
      const result = text === undefined ? INCOMPLETE : stated(text, this.dir, this.instance);
      if (result.complete && result.row !== undefined) {
        complete.set(name, result.row);
        rows.set(result.row.pid, result.row);
        continue;
      }
      // A complete document for a dead process states no row and keeps none.
      if (result.complete) continue;
      const previous = this.#lastComplete.get(name);
      if (previous === undefined) continue;
      complete.set(name, previous);
      rows.set(previous.pid, previous);
    }
    this.#lastComplete = complete;
    this.#rows = rows;
  }
}

/** One state file as a reading found it, or with nothing where the file could
 * not be read at all — which is the same to a reader as a document it cannot
 * parse. */
interface State {
  readonly name: string;
  readonly text: string | undefined;
}

const INCOMPLETE: RowResult = { complete: false };

function stateFiles(names: readonly string[]): string[] {
  return names.filter((name) => STATE_FILE.test(name));
}

/** What one state file's text states, or that it states nothing yet. */
function stated(text: string, configDir: string, instance: InstanceId): RowResult {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return INCOMPLETE;
  }
  return toRow(document, configDir, instance);
}

async function contents(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function contentsNow(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
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
 * (DESIGN §2.4): renamed to snake_case, instants in Unix ms, and nothing carried over
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
    // daemon and the sessions of its config home run as one uid (DESIGN §1.4 A4).
    return false;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}
