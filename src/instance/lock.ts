import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

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

/** How many rounds of "somebody else's file is stale, drop it and contend
 * again" one acquisition may run. Each round either wins, names a live holder
 * or removes one dead file, so reaching this means the file is being recreated
 * as fast as it is removed, or is something no starter can read or unlink. A
 * loop is the wrong answer to either; the caller is told instead. */
const ROUNDS = 100;

/** Take the lock, or report who has it.
 *
 * The lock file is created by linking a file that already names its pid, so it
 * exists only in the finished state: a starter that finds it never reads an
 * empty file and never mistakes a lock being taken for a stale one. `link` is
 * what excludes — it fails when the name is there — so two processes racing
 * for the same config home cannot both win.
 *
 * What that does not settle is a file left by a process that died without
 * releasing it: the file names its pid, so the next starter asks the OS whether
 * that pid is still there and takes over the file when it is not. Asking is
 * signal 0, which tests for the process without touching it. */
export function acquireLock(file: string): Lock | Held {
  mkdirSync(dirname(file), { recursive: true });
  for (let round = 0; round < ROUNDS; round++) {
    const staged = `${file}.${process.pid}.${randomUUID()}`;
    writeFileSync(staged, `${process.pid}\n`);
    try {
      linkSync(staged, file);
      return { release: () => release(file) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    } finally {
      try {
        unlinkSync(staged);
      } catch {
        // The link is what matters; the staging name is scratch either way.
      }
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
  throw new Error(`${file} could neither be taken nor cleared`);
}

/** Whether a lock outcome is the lock itself rather than someone else's. */
export function isHeldByUs(outcome: Lock | Held): outcome is Lock {
  return "release" in outcome;
}

function release(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
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
