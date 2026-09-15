import type { SessionRun, Timestamp } from "@ccmsg/protocol";

/** One process this instance can see running a session, before it is stated as
 * a run: what the harness's state file says, or what a launcher started.
 *
 * `started_at` travels with the pid wherever the pid goes (contract,
 * `SessionRun`): it is what tells a pid the OS has since handed to something
 * else from the run it was read for. */
export interface ObservedRun {
  readonly pid: number;
  readonly started_at: Timestamp;
  readonly terminal_id?: string;
}

/** The runs of one session, as the row states them.
 *
 * A connection is not by itself a second process. A greeting names the harness
 * process it speaks for, and where it does the connection is attributed to that
 * run; where it does not — an older client, or one that could not read its own
 * parent — the connection is attributed to the one observed run when there is
 * exactly one, and to none when there are several. Inventing a run for an
 * unattributed connection would report a duplicate that is not there, and a
 * duplicate is what freezes the fold and refuses every send.
 *
 * A session nothing has been observed of is the other way round. It is running
 * all the same when a connection is open for it, or when the harness says it is
 * there without saying what is running it — Codex names a thread with a live
 * writer and no pid — and that is one run with no pid, which is also why
 * nothing here can signal such a run.
 *
 * `present` is the harness's own word that the session exists, which is a
 * weaker statement than a state file: it says there is a process and not which
 * one. Two of those cannot be told apart, so it is never more than one run and
 * never makes a session duplicated. */
export function runsOf(
  observed: readonly ObservedRun[],
  greeted: ReadonlySet<number>,
  connected: boolean,
  present = false,
): SessionRun[] {
  const runs: SessionRun[] = observed.map((run) => ({
    pid: run.pid,
    started_at: run.started_at,
    ...(run.terminal_id === undefined ? {} : { terminal_id: run.terminal_id }),
    connected: greeted.has(run.pid),
  }));
  if (runs.length === 0 && (connected || present)) return [{ connected }];
  if (!connected) return runs;
  const only = runs[0];
  if (runs.length === 1 && only !== undefined && !only.connected) only.connected = true;
  return runs;
}

/** Whether the session is one two or more processes are writing, which is what
 * freezes its fold and refuses the ops that would act on it. */
export function duplicated(runs: readonly SessionRun[]): boolean {
  return runs.length >= 2;
}
