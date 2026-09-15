import { HYOUI_TERMINAL_SCHEME, type SessionRun, type Timestamp } from "@ccmsg/protocol";

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
 * A session with connections and nothing observed is the other way round: the
 * connection is the only evidence there is a process at all, so it is one run
 * with no pid — which is also why nothing here can signal such a run. */
export function runsOf(
  observed: readonly ObservedRun[],
  greeted: ReadonlySet<number>,
  connected: boolean,
): SessionRun[] {
  const runs: SessionRun[] = observed.map((run) => ({
    pid: run.pid,
    started_at: run.started_at,
    ...(run.terminal_id === undefined ? {} : { terminal_id: run.terminal_id }),
    connected: greeted.has(run.pid),
  }));
  if (!connected) return runs;
  if (runs.length === 0) return [{ connected: true }];
  const only = runs[0];
  if (runs.length === 1 && only !== undefined && !only.connected) only.connected = true;
  return runs;
}

/** Whether the session is one two or more processes are writing, which is what
 * freezes its fold and refuses the ops that would act on it. */
export function duplicated(runs: readonly SessionRun[]): boolean {
  return runs.length >= 2;
}

/** A terminal handle as the wire states it: the scheme the gateway serves, and
 * the handle the multiplexer knows it by.
 *
 * The scheme is what decides how a client opens it (contract, `terminalUrl`),
 * and the bare handle is what this instance types into — so the two forms are
 * kept apart rather than one being parsed back out of the other at each use. */
export function statedTerminalId(id: string): string {
  return `${HYOUI_TERMINAL_SCHEME}:${id}`;
}
