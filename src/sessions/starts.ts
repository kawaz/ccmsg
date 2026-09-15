import type { Timestamp } from "@ccmsg/protocol";
import { sameProcess } from "./processes.ts";

/** When one process started, as the host states it. Undefined where the host
 * stated something this instance could not read as an instant. The effect is
 * injected for the same reason every other process effect is: the answer comes
 * from a child, and a test states it instead. */
export type StartReader = (pid: number) => Promise<Timestamp | undefined>;

/** Read, and what the reading found. `null` is "asked, and the host could not
 * say", which is not the same as not having asked. */
type Read = Timestamp | null;

/** Whether the process under a state file's pid is the one that file was
 * written for, read once per pid.
 *
 * A state file outlives a session that was killed outright, and a pid the OS
 * has since handed to something else makes that file look like a running
 * process. Under a reading keyed by pid that is not a stale row nobody
 * notices — it is a **second run of the session the file names**, which freezes
 * the fold and refuses every send, and which nothing a person can do will
 * clear. So the pid is checked against when its process actually started,
 * which is the key the contract gives for exactly this (`SessionRun.started_at`).
 *
 * Read once per pid and remembered, for the reason the terminal is: the
 * directory is read whenever it may have moved, and a child per session per
 * reading is not something a reading can cost. A pid the last reading no
 * longer holds is forgotten, which is both how the map stays the size of the
 * session list and how a pid that comes back is read afresh rather than
 * answered from what ran under it before.
 *
 * **A pid not yet read counts as its row's own.** The reading is a child and
 * takes milliseconds; treating an unread pid as a stranger would make every
 * session that has just started invisible for that long — `session_not_found`
 * to a sender, and absent from the list — which is a certain harm against the
 * rare one this guards. */
export class StartCache {
  readonly #known = new Map<number, Read>();
  readonly #reading = new Set<number>();

  constructor(
    private readonly read: StartReader,
    /** A read finished, so a row may be gone from the list that was in it when
     * the list was last built. Whoever publishes the list is told. */
    private readonly filled: () => void,
  ) {}

  /** Whether the row written for this pid describes the process running under
   * it now. */
  own(pid: number, startedAt: Timestamp): boolean {
    const read = this.#known.get(pid);
    // Not asked yet, or asked and told nothing: the row stands. The second is
    // the same fallback the ops that signal a process make — refusing on a host
    // whose `ps` states elapsed time in some other form would make them
    // unusable there.
    if (read === undefined || read === null) return true;
    return sameProcess(read, startedAt);
  }

  /** The pids that exist now. New ones are read, gone ones are forgotten. */
  observe(pids: Iterable<number>): void {
    const present = new Set(pids);
    for (const pid of this.#known.keys()) {
      if (!present.has(pid)) this.#known.delete(pid);
    }
    for (const pid of present) {
      if (this.#known.has(pid) || this.#reading.has(pid)) continue;
      this.#reading.add(pid);
      void this.#fill(pid);
    }
  }

  async #fill(pid: number): Promise<void> {
    let started: Timestamp | undefined;
    try {
      started = await this.read(pid);
    } catch {
      // A process that ended while it was being read, or a host that does not
      // let this one read it. Neither says the row is somebody else's.
    } finally {
      this.#reading.delete(pid);
    }
    this.#known.set(pid, started ?? null);
    this.filled();
  }
}
