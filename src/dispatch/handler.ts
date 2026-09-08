import type { OpName, Role } from "@ccmsg/protocol";
import type { SettledIdentity } from "./identity.ts";

/** What an op implementation receives.
 *
 * The arguments are already validated and the caller is already allowed
 * (daemon-v2 §3.2): a handler starts from "this may be run", so it holds no
 * check of its own. */
export interface HandlerInput {
  readonly op: OpName;
  /** The whole request frame, validated against the op's request schema. */
  readonly args: Record<string, unknown>;
  /** The connection's identity, absent for the two ops that run before `hello`. */
  readonly identity?: SettledIdentity;
  /** Set only for ops the attribute table marks `scope: "role"`, where the role
   * changes what the reply may contain rather than whether the call is allowed.
   * This is the only route by which a role reaches an implementation
   * (daemon-v2 §3.2). */
  readonly role?: Role;
}

/** An op implementation. It answers with the op's response body (dispatch adds
 * `ok` and `request_id`, so the body never carries the reply's envelope), and
 * may answer with a promise of one — dispatch awaits what it returns. */
export type OpHandler = (input: HandlerInput) => unknown;

/** One handler per op in the contract. The record is total on purpose: an op
 * added to the attribute table does not compile until it has an implementation
 * reachable through dispatch (M1). */
export type Handlers = Readonly<Record<OpName, OpHandler>>;
