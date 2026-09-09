import type { ErrorCode } from "@ccmsg/protocol";
import { type Env, resolveSupervisorSocket } from "../instance/paths.ts";
import { connect } from "./control.ts";

/** What a command asks the supervisor for.
 *
 * Its own protocol, not the contract's: these are requests about processes on
 * this host, spoken over a socket no client outside it reaches, and nothing
 * here is something a web UI or a mesh peer may ask. The `supervise_` prefix is
 * what keeps the two from being read as one — an op name here is not an op
 * name there, and no attribute table covers these. */
export const SUPERVISE_OPS = [
  "supervise_start",
  "supervise_stop",
  "supervise_restart",
  "supervise_status",
  "supervise_add",
  "supervise_remove",
] as const;

export type SuperviseOp = (typeof SUPERVISE_OPS)[number];

export interface SuperviseRequest {
  readonly op: SuperviseOp;
  /** The config home the request is about. Absent with `all`. */
  readonly dir?: string;
  /** Every config home the supervisor looks after. */
  readonly all?: boolean;
}

/** Why a command could not be carried out.
 *
 * The contract's codes wherever one fits, because a person reading a ccmsg
 * error should not have to learn a second vocabulary for the same thing. The
 * one addition is the failure the contract has no word for: there is no
 * supervisor, which is not an op being refused but nobody being there to
 * refuse it. */
export type CliErrorCode = ErrorCode | "supervisor_not_running";

/** The one command that answers without a supervisor is `daemon log`: a log is
 * read after something died, and requiring the supervisor to be up would make
 * the record unreadable exactly when it is wanted. */
export const NO_SUPERVISOR: CliErrorCode = "supervisor_not_running";

export class CommandError extends Error {
  constructor(
    readonly code: CliErrorCode,
    msg: string,
    /** What the command found before it stopped, for a failure that has more
     * to say than a line: the same report the command would have answered
     * with. Printed beside the error so a caller reads one shape whether the
     * command worked or not. */
    readonly detail?: unknown,
  ) {
    super(msg);
    this.name = "CommandError";
  }
}

export function noSupervisor(): CommandError {
  return new CommandError(
    NO_SUPERVISOR,
    "監督者が動いていません (`ccmsg service start` か `ccmsg daemon supervise` で起動してください)",
  );
}

/** Put one request to the supervisor, and answer with what it said.
 *
 * A connection per command: these are one exchange each, and a socket that
 * outlived the command would be a client the supervisor has to keep track of
 * for nothing. */
export async function ask(request: SuperviseRequest, env: Env = process.env): Promise<unknown> {
  const conn = await connect(resolveSupervisorSocket(env));
  if (conn === undefined) throw noSupervisor();
  try {
    const answer = await conn.ask({ ...request });
    if (answer["ok"] === true) return answer["result"];
    const error = answer["error"] as { code?: CliErrorCode; msg?: string } | undefined;
    throw new CommandError(error?.code ?? "internal_error", error?.msg ?? JSON.stringify(answer));
  } finally {
    conn.close();
  }
}

/** Whether a supervisor is there at all, for the two commands that carry on
 * without one rather than failing: writing the config is worth doing whether or
 * not anybody is listening for the news. */
export async function reachable(env: Env = process.env): Promise<boolean> {
  const conn = await connect(resolveSupervisorSocket(env));
  if (conn === undefined) return false;
  conn.close();
  return true;
}
