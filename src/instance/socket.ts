import { mkdirSync, readdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { alive } from "./lock.ts";
import type { InstancePaths } from "./paths.ts";
import { REAL_SOCKET } from "./paths.ts";

/** Point the stable address at the socket this process bound.
 *
 * Through a temporary name and a rename, because that is the only way to
 * replace a symlink without a moment where the address does not exist:
 * `symlink` itself refuses an existing name, and unlinking first would leave a
 * window in which a client finds nothing rather than finding the predecessor.
 *
 * Called after the listener is up, so the address never names a socket that is
 * not yet accepting. */
export function publishSocket(paths: InstancePaths): void {
  const temporary = `${paths.socket}.${process.pid}.new`;
  removeQuietly(temporary);
  symlinkSync(basename(paths.socketReal), temporary);
  renameSync(temporary, paths.socket);
}

/** Remove the real sockets of runs that are gone.
 *
 * A departing instance takes its own path with it, so what this finds is what
 * a killed one left: the file names the pid that bound it, and the OS is asked
 * whether that pid is still there — the same question the lock asks of the
 * same kind of leftover.
 *
 * The stable address is never swept. It may already point at a successor, and
 * one pointing at a socket that is gone is the "the unix socket refuses"
 * a client reads as this instance having finished leaving (DESIGN §8.5). */
export function sweepOrphanSockets(paths: InstancePaths): void {
  let names: string[];
  try {
    names = readdirSync(paths.socketDir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = REAL_SOCKET.exec(name);
    if (match?.[1] === undefined) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || alive(pid)) continue;
    removeQuietly(join(paths.socketDir, name));
  }
}

/** The socket directory, which is the state directory unless the address would
 * not fit there. Its own mode, because a directory under `/tmp` is not private
 * by construction the way one under the state directory is. */
export function prepareSocketDir(paths: InstancePaths): void {
  mkdirSync(paths.socketDir, { recursive: true, mode: 0o700 });
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Not there, which is the state this wanted.
  }
}
