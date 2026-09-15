import { isHarness, launchedAs } from "../harness/index.ts";

/** One process as this host states it: what started it, and what it was
 * launched as. Named so a test can describe a tree it never has to create. */
export type AskProcess = (pid: number) => Ancestor | undefined;

export interface Ancestor {
  readonly ppid: number;
  /** The command line, of which only the first word is read. */
  readonly command: string;
}

/** How far up the tree the harness is looked for.
 *
 * A greeting is carried by something standing in for the session — a hook the
 * harness spawned, a `ccmsg post` the session ran — and either may have a shell
 * or two between it and the harness. A few levels covers that; an unbounded
 * walk would reach init on a process that is not below a harness at all. */
const DEPTH = 8;

/** The harness process this command is running inside, or nothing.
 *
 * What a greeting names is the run, and the helper carrying the greeting is not
 * one (contract, `HelloSessionArgs.pid`): the pid that ties this session to a
 * process a launcher started is the harness's own. So the ancestors are walked
 * until one of them was launched as the harness.
 *
 * Nothing when none of them was, which is a command run outside a session — or
 * a host whose `ps` this cannot read. The greeting goes without the field, and
 * the instance then knows the run by its connection alone. */
export function harnessPid(
  ask: AskProcess = askPs,
  from: number = process.ppid,
): number | undefined {
  let pid = from;
  for (let step = 0; step < DEPTH; step++) {
    if (!Number.isInteger(pid) || pid <= 1) return undefined;
    const ancestor = ask(pid);
    if (ancestor === undefined) return undefined;
    if (isHarness(launchedAs(ancestor.command))) return pid;
    pid = ancestor.ppid;
  }
  return undefined;
}

/** What the greeting carries about the run it speaks for, which is the field or
 * nothing at all. */
export function statedRun(ask: AskProcess = askPs): { pid?: number } {
  const pid = harnessPid(ask);
  return pid === undefined ? {} : { pid };
}

const askPs: AskProcess = (pid) => {
  try {
    const done = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid=,command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (done.exitCode !== 0) return undefined;
    const line = done.stdout.toString().trim();
    const at = line.search(/\s/);
    if (at <= 0) return undefined;
    const ppid = Number(line.slice(0, at));
    return Number.isInteger(ppid) ? { ppid, command: line.slice(at + 1).trimStart() } : undefined;
  } catch {
    // No `ps` on this host, or a pid that has gone. Either way the run cannot
    // be named, which is a greeting the instance accepts without it.
    return undefined;
  }
};
