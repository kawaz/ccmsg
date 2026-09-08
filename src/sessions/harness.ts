import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInfo, InstanceId, Sid } from "@ccmsg/protocol";

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

/** The sessions the harness itself reports, read from one config home.
 *
 * The directory is the whole input: it says which sessions exist and which is
 * waiting on a dialog (§5.1). Only the config home this instance was given is
 * ever opened (M6) — the path is handed in, and nothing here searches for
 * another one. */
export class HarnessSessions {
  #rows: ReadonlyMap<Sid, AgentInfo> = new Map();
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #reading: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly instance: InstanceId,
    private readonly onChange: () => void,
    private readonly pollMs: number = CONFIRM_POLL_MS,
  ) {}

  get rows(): ReadonlyMap<Sid, AgentInfo> {
    return this.#rows;
  }

  get running(): boolean {
    return this.#watcher !== undefined || this.#timer !== undefined;
  }

  /** Begins watching. Called when the first subscriber arrives and not before
   * (§6.3 / §8.3: no upstream is read until somebody is listening). */
  start(): void {
    if (this.running) return;
    try {
      this.#watcher = watch(this.dir, () => void this.refresh());
    } catch {
      // The directory does not exist yet — a config home whose harness has not
      // run. The poll below both covers the wait and picks it up when it
      // appears, so this is not a failure to start.
      this.#watcher = undefined;
    }
    this.#timer = setInterval(() => void this.refresh(), this.pollMs);
    void this.refresh();
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Re-read the directory and tell the owner. Whether the result differs from
   * the last one is not asked here: deciding that would be a second copy of
   * the suppression the topic mechanism already holds for every topic (M5), so
   * a read that found nothing new turns into a payload equal to the last one
   * and stops there.
   *
   * Reads are chained rather than overlapped, so two events arriving together
   * cannot interleave their directory listings. */
  refresh(): Promise<void> {
    this.#reading = this.#reading.then(() => this.#read());
    return this.#reading;
  }

  /** Read the directory now, without disturbing what the watch holds.
   *
   * The ops that act on a session's process resolve its pid through this
   * rather than through `rows`: the watch runs only while somebody is
   * subscribed (§6.3), so the cache is empty for an instance nobody is
   * watching and stale for one whose last poll is seconds old — and a stale
   * pid is a signal sent to whatever now holds that number. */
  async scan(): Promise<ReadonlyMap<Sid, AgentInfo>> {
    return await this.#scan();
  }

  async #read(): Promise<void> {
    this.#rows = await this.#scan();
    this.onChange();
  }

  async #scan(): Promise<ReadonlyMap<Sid, AgentInfo>> {
    const rows = new Map<Sid, AgentInfo>();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!STATE_FILE.test(name)) continue;
      const row = await this.#row(join(this.dir, name));
      if (row !== undefined) rows.set(row.sid, row);
    }
    return rows;
  }

  async #row(path: string): Promise<AgentInfo | undefined> {
    let document: unknown;
    try {
      document = JSON.parse(await readFile(path, "utf8"));
    } catch {
      // Missing (the session ended between listing and reading) or half
      // written, which the next event resolves.
      return undefined;
    }
    return toRow(document, this.dir, this.instance);
  }
}

/** Whether the harness says this session is waiting on a dialog. */
export function isWaiting(row: AgentInfo): boolean {
  return row.status === WAITING;
}

/** The conversion of one upstream document into the contract's spelling
 * (§3.5): renamed to snake_case, instants in Unix ms, and nothing carried over
 * that the contract does not name.
 *
 * A row whose process is gone is dropped: the file outlives a session that did
 * not clean up after itself, and "the session exists" is what this input is
 * for. */
function toRow(document: unknown, configDir: string, instance: InstanceId): AgentInfo | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const raw = document as Record<string, unknown>;
  const sid = text(raw["sessionId"]);
  const pid = raw["pid"];
  const cwd = text(raw["cwd"]);
  const kind = text(raw["kind"]);
  const startedAt = raw["startedAt"];
  if (sid === undefined || cwd === undefined || kind === undefined) return undefined;
  if (typeof pid !== "number" || typeof startedAt !== "number") return undefined;
  if (!alive(pid)) return undefined;
  return {
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
