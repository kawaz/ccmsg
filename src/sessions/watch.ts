import { type FSWatcher, readdirSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname } from "node:path";

/** How long after arming a watch the directory is said to have moved once more.
 *
 * Arming is not instant, and the change that races it is the one change a watch
 * does not report: measured on macOS/Bun, a watch armed on a directory reports
 * what happens to it from then on (nothing missed over hundreds of changes,
 * under load and from other processes, within ~100ms), while a change made in
 * the same instant as the arming is dropped for under 1 % of them
 * (`docs/findings/2026-09-15-fs-watch-reliability.md`). Arming takes ~12ms, and
 * ~50ms at its worst under load, so a reading at this distance is past it — and
 * it is one reading rather than an interval, because what it covers happens
 * once per subscription. */
const ARMED_AFTER_MS = 500;

/** One directory, said to have moved whenever it may have, while somebody is
 * subscribed.
 *
 * The two things DESIGN §6.3 separates live here. Watching the directory says
 * the answer may have changed, which is only worth knowing while somebody is
 * listening — so the watch is what the subscription drives. Reading it settles
 * the answer, and is started by the watch, by the poll, and by whoever must act
 * on the directory as it is now.
 *
 * Two watches rather than one, because a watch armed on a directory says
 * nothing about that directory's own existence: arming one where the directory
 * is not there fails outright, and the removal of a watched directory is never
 * reported (both measured). The nearest directory above that does exist reports
 * both — it is what says the directory appeared, and the directory watch is
 * armed from there when it does. A directory replaced at the same path needs no
 * re-arming: the watch follows the path and not the inode (measured).
 *
 * A confirmation interval is what a caller asks for by handing one in, and a
 * caller that hands none runs none. */
export class DirectoryWatch {
  #watcher: FSWatcher | undefined;
  #above: FSWatcher | undefined;
  #armed: ReturnType<typeof setTimeout> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(
    private readonly dir: string,
    /** Read again: the directory may have moved. */
    private readonly onChange: () => void,
    /** How often to confirm the directory regardless of what the watch says.
     * Absent where nothing about the directory changes unobserved. */
    private readonly pollMs?: number,
  ) {}

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#arm();
    this.#confirmArm();
    this.#armAbove();
    if (this.pollMs !== undefined) this.#timer = setInterval(this.onChange, this.pollMs);
    this.onChange();
  }

  stop(): void {
    this.#running = false;
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#above?.close();
    this.#above = undefined;
    if (this.#armed !== undefined) clearTimeout(this.#armed);
    this.#armed = undefined;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** What is in the directory. A directory that is not there is a config home
   * whose harness has not run, and it holds nothing. */
  async names(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch {
      return [];
    }
  }

  /** The same reading, made once before the instance holds a connection
   * (DR-0015 §2.4). */
  namesNow(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }

  #arm(): boolean {
    if (this.#watcher !== undefined) return false;
    try {
      this.#watcher = watch(this.dir, this.onChange);
      return true;
    } catch {
      this.#watcher = undefined;
      return false;
    }
  }

  #confirmArm(): void {
    if (this.#armed !== undefined) clearTimeout(this.#armed);
    this.#armed = setTimeout(() => this.#moved(), ARMED_AFTER_MS);
    // A timer of this instance's own must not be what keeps the process up: an
    // instance with nothing to do exits on its listeners, not on a reading it
    // is about to make anyway.
    this.#armed.unref?.();
  }

  /** Watch the nearest directory above this one that exists, which is what says
   * the directory itself appeared or was removed. */
  #armAbove(): void {
    this.#above?.close();
    this.#above = undefined;
    for (let path = dirname(this.dir); ; path = dirname(path)) {
      try {
        this.#above = watch(path, () => this.#moved());
        return;
      } catch {
        // The parent is not there either; keep walking up. A path is its own
        // parent only at the root, which is where the walk stops — a host with
        // no readable root has nothing to watch and nothing to read.
        if (dirname(path) === path) return;
      }
    }
  }

  /** Something above the directory moved.
   *
   * It may be the directory appearing, which is what arms the watch on it. It
   * may also be an intermediate directory appearing, in which case the nearest
   * existing ancestor is now deeper than the one being watched and the watch
   * above moves down to it — otherwise the directory's own creation, one level
   * further down, would be reported by nothing. */
  #moved(): void {
    const armed = this.#watcher !== undefined;
    if (this.#arm()) this.#confirmArm();
    if (!armed && this.#watcher === undefined) this.#armAbove();
    this.onChange();
  }
}
