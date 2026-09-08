import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LAST_LIVE_RETENTION_MS,
  type LastLiveSession,
  type Sid,
  type Timestamp,
} from "@ccmsg/protocol";

export const LAST_LIVE_FILE = "last-live.json";

/** What is stored per session: the contract's entry, minus the one field that
 * is derived rather than observed.
 *
 * `state` is left out on purpose (M4). It follows from `stopped_at` and from
 * whether the session is live again, both of which are known when the list is
 * read, so storing it would be storing a conclusion that can go stale on disk.
 * `pinned` is left out because no pin is held anywhere yet; when one is, it
 * belongs to the session rather than to this list. */
export type StoredEntry = Omit<LastLiveSession, "state" | "pinned">;

interface Document {
  version: number;
  sessions: StoredEntry[];
}

const VERSION = 1;

/** The sessions that were running when this instance last saw them.
 *
 * One of the three things written to disk (§3.6): losing it loses the Paused
 * and Disappeared rows of the list entirely, and nothing else on the host
 * remembers that a session used to be here. Only observations are stored — the
 * classification is derived from them at read time, never written (M4). */
export class LastLiveStore {
  #entries = new Map<Sid, StoredEntry>();

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
    for (const entry of sessions as StoredEntry[]) {
      if (typeof entry?.sid === "string") this.#entries.set(entry.sid, entry);
    }
    this.#prune(now);
  }

  /** Every entry still within the retention window. */
  entries(now: Timestamp = Date.now()): StoredEntry[] {
    if (this.#prune(now)) this.#save();
    return [...this.#entries.values()];
  }

  get(sid: Sid): StoredEntry | undefined {
    return this.#entries.get(sid);
  }

  /** Note a session as no longer live. A `stopped_at` already recorded for it
   * survives, since the session being gone is what that stop led to; the entry
   * carries one when the session declared it was going, which is what makes it
   * Paused rather than Disappeared (§5.2). */
  record(entry: StoredEntry): void {
    const stopped = this.#entries.get(entry.sid)?.stopped_at ?? entry.stopped_at;
    this.#entries.set(entry.sid, stopped === undefined ? entry : { ...entry, stopped_at: stopped });
    this.#save();
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
