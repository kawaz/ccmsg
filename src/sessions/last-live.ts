import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LastLiveSession, Sid, Timestamp } from "@ccmsg/protocol";

/** How long an entry is kept after the session was last seen.
 *
 * Seven days, the window daemon-v2 §12 DV-Q12 gives the inbox, `last_live` and
 * a severed instance's share alike. The contract does not carry the number
 * yet, so it is stated here once and read from here. */
export const LAST_LIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const LAST_LIVE_FILE = "last-live.json";

/** One entry, which is the contract's `LastLiveSession` plus the one fact the
 * contract has no field for.
 *
 * `stopped_at` separates Paused from Disappeared (§5.2) and is set only when
 * somebody stopped the session on purpose. Nothing derives it: a session that
 * simply went away has none, which is exactly what Disappeared means. It stays
 * out of the `peers` payload because the contract's type has no place for it. */
export interface LastLiveEntry extends LastLiveSession {
  stopped_at?: Timestamp;
}

interface Document {
  version: number;
  sessions: LastLiveEntry[];
}

const VERSION = 1;

/** The sessions that were running when this instance last saw them.
 *
 * One of the three things written to disk (§3.6): losing it loses the Paused
 * and Disappeared rows of the list entirely, and nothing else on the host
 * remembers that a session used to be here. Only observations are stored — the
 * classification is derived from them at read time, never written (M4). */
export class LastLiveStore {
  #entries = new Map<Sid, LastLiveEntry>();

  constructor(private readonly file: string) {}

  /** Read at startup (§8.3 step 4), before anything can ask for the list. A
   * file that is missing or unreadable starts an empty list: the daemon has no
   * way to recover it and refusing to start would cost more than the rows. */
  load(now: Timestamp = Date.now()): void {
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const sessions = (document as Document | null)?.sessions;
    if (!Array.isArray(sessions)) return;
    for (const entry of sessions as LastLiveEntry[]) {
      if (typeof entry?.sid === "string") this.#entries.set(entry.sid, entry);
    }
    this.#prune(now);
  }

  /** Every entry still within the retention window. */
  entries(now: Timestamp = Date.now()): LastLiveEntry[] {
    if (this.#prune(now)) this.#save();
    return [...this.#entries.values()];
  }

  get(sid: Sid): LastLiveEntry | undefined {
    return this.#entries.get(sid);
  }

  /** Note a session as no longer live. A `stopped_at` already recorded for it
   * survives, since the session being gone is what that stop led to. */
  record(entry: LastLiveEntry): void {
    const stopped = this.#entries.get(entry.sid)?.stopped_at;
    this.#entries.set(entry.sid, stopped === undefined ? entry : { ...entry, stopped_at: stopped });
    this.#save();
  }

  /** Mark a session as stopped on purpose, which is what makes it Paused
   * rather than Disappeared. */
  markStopped(sid: Sid, at: Timestamp = Date.now()): boolean {
    const entry = this.#entries.get(sid);
    if (entry === undefined) return false;
    this.#entries.set(sid, { ...entry, stopped_at: at });
    this.#save();
    return true;
  }

  /** Drop one entry: `session_last_live_remove`, and a session registering
   * again, which is what moves it back to the connected list. */
  remove(sid: Sid): boolean {
    if (!this.#entries.delete(sid)) return false;
    this.#save();
    return true;
  }

  #prune(now: Timestamp): boolean {
    let dropped = false;
    for (const [sid, entry] of this.#entries) {
      if (now - entry.last_seen_at <= LAST_LIVE_RETENTION_MS) continue;
      this.#entries.delete(sid);
      dropped = true;
    }
    return dropped;
  }

  /** Written whole through a temporary file, so a daemon killed mid-write
   * leaves the previous list rather than half of this one. */
  #save(): void {
    const document: Document = { version: VERSION, sessions: [...this.#entries.values()] };
    const temporary = `${this.file}.${process.pid}.tmp`;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(document)}\n`);
    renameSync(temporary, this.file);
  }
}

/** Where the list lives for an instance whose state directory is `stateDir`
 * (§8.1: every per-instance path is derived from its config home). */
export function lastLivePath(stateDir: string): string {
  return join(stateDir, LAST_LIVE_FILE);
}
