import type { Terminal } from "./processes.ts";

/** Reads the terminal one process names, or nothing when it names none. The
 * effect is injected for the same reason every other process effect is: the
 * host's answer comes from a child, and a test states it instead. */
export type TerminalReader = (pid: number) => Promise<Terminal | undefined>;

/** The terminal each live session runs in, read once per process.
 *
 * `agents` states a session's terminal and the classification reads it: a live
 * session that neither holds a connection here nor names a terminal is the one
 * nothing can reach (§5.2, `live_unmanaged`). Both want the value on every
 * row, and neither may pay for it on every read — the harness's directory is
 * scanned whenever any question is asked of it, and reading every session's
 * environment there would spawn a child per session per question.
 *
 * So the value is remembered per pid and read exactly once for a pid the scan
 * has not seen before. A pid the scan no longer holds is forgotten, which is
 * both how the map stays the size of the session list and how a resumed
 * session — a new process, possibly in another terminal — is read afresh
 * rather than answered from what the process before it named. */
export class TerminalCache {
  /** A pid that has been read. Undefined as a value means the process named no
   * terminal, which is remembered so it is not asked again. */
  readonly #known = new Map<number, Terminal | undefined>();
  readonly #reading = new Set<number>();

  constructor(
    private readonly read: TerminalReader,
    /** A read finished, so a row may say something it did not when the list
     * was last built. Whoever publishes the list is told — including when the
     * process named no terminal, because "asked and told nothing" is what the
     * row settles on and suppressing an unchanged payload is the topic
     * mechanism's to do (M5), not this one's. */
    private readonly filled: () => void,
  ) {}

  /** What the pid's process named, as far as is known right now. Undefined
   * covers both "not read yet" and "names none": neither is a terminal to type
   * into, and nothing here asks further of the difference. */
  get(pid: number): Terminal | undefined {
    return this.#known.get(pid);
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
    let terminal: Terminal | undefined;
    try {
      terminal = await this.read(pid);
    } catch {
      // A process that ended while it was being read, or a host that does not
      // let this one read it. The session's terminal is unknown, which is a
      // state the classification has.
    } finally {
      this.#reading.delete(pid);
    }
    this.#known.set(pid, terminal);
    this.filled();
  }
}
