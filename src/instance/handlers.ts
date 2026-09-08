import { OP_NAMES, type OpName } from "@ccmsg/protocol";
import { type Handlers, type OpHandler, OpError } from "../dispatch/index.ts";

/** The answer for an op the contract defines and this instance does not
 * implement yet.
 *
 * One handler for all of them rather than one per op: what they have in common
 * is the only thing they say. `not_found` is the contract's code for a subject
 * that is not there, and the subject of an unimplemented op never is — the
 * message is what tells a caller that the gap is the instance's rather than
 * their arguments'. */
export function unimplemented(op: OpName): OpHandler {
  return () => {
    throw new OpError("not_found", `${op} is not implemented by this instance yet`);
  };
}

/** One handler per op in the contract (M1).
 *
 * The record is built by walking the op names, so an op added to the attribute
 * table arrives here as unimplemented rather than as a dispatch that finds no
 * handler. What is given wins over that default. */
export function completeHandlers(implemented: Partial<Handlers>): Handlers {
  const entries = OP_NAMES.map(
    (op) => [op, implemented[op] ?? unimplemented(op)] as const satisfies [OpName, OpHandler],
  );
  return Object.fromEntries(entries) as Handlers;
}
