import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** The right to be the instance for one config home (§8.3 step 2).
 *
 * A handle, not state (§3.6): it says who is running right now and means
 * nothing once the process is gone. */
export interface Lock {
  release(): void;
}

/** Whoever holds it, when we do not. */
export interface Held {
  readonly pid: number;
}

/** Take the lock, or report who has it.
 *
 * `O_EXCL` is the whole of the exclusion, so two processes racing for the same
 * config home cannot both win. What it does not settle is a lock file left by
 * a process that died without releasing it: the file names its pid, so the
 * next starter asks the OS whether that pid is still there and takes over the
 * file when it is not. Asking is signal 0, which tests for the process without
 * touching it. */
export function acquireLock(file: string): Lock | Held {
  mkdirSync(dirname(file), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, `${process.pid}\n`);
      return { release: () => release(file, fd) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    const holder = readHolder(file);
    if (holder !== undefined && alive(holder)) return { pid: holder };
    // Nobody is behind the file: drop it and contend again, so two starters
    // finding the same stale lock still produce one winner.
    try {
      unlinkSync(file);
    } catch {
      // Another starter got there first; the next attempt sees its file.
    }
  }
}

/** Whether a lock outcome is the lock itself rather than someone else's. */
export function isHeldByUs(outcome: Lock | Held): outcome is Lock {
  return "release" in outcome;
}

function release(file: string, fd: number): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
  try {
    // After the unlink: the file name is what excludes, and closing first
    // would leave a window with neither.
    closeSync(fd);
  } catch {
    // Already closed.
  }
}

function readHolder(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a pid names a process that is still there. Signal 0 asks the OS
 * without touching it, which is how both the stale lock and the orphaned
 * socket of a previous run are told from a live one. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists and belongs to somebody else, which
    // cannot happen here (A4, single uid) but still means "there".
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}
