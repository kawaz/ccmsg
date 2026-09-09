import {
  type Capability,
  type InstanceId,
  isRoleAllowed,
  OP_ATTRIBUTES,
  OP_SCHEMAS,
  opAttributes,
  type OpName,
  validationErrors,
} from "@ccmsg/protocol";
import type { Handlers, Requester } from "./handler.ts";
import { type DispatchResult, failure, OpError, reply } from "./result.ts";

/** What dispatch needs from the instance around it. */
export interface DispatchDeps {
  /** This instance's own id, compared with the destination of an
   * `instance-local` op to decide whether the op is ours to run. */
  readonly self: InstanceId;
  /** The capabilities this instance has, as `hello` reports them. */
  readonly capabilities: ReadonlySet<Capability>;
  /** The instance that owns the subject of an `instance-local` op, or
   * `undefined` when no other instance owns it and we answer ourselves.
   * The routing table behind this is the `peers` topic (daemon-v2 §7.3). */
  readonly resolveInstance: (op: OpName, frame: Record<string, unknown>) => InstanceId | undefined;
  readonly handlers: Handlers;
}

function isOpName(op: string): op is OpName {
  return Object.hasOwn(OP_ATTRIBUTES, op);
}

/** Decide one frame.
 *
 * The six steps of daemon-v2 §3.2 are written once, here, and read the op
 * attribute table for every op. Adding an op is a row in the table plus a
 * schema and an implementation — never a check in this function (M1). */
export async function dispatch(
  frame: unknown,
  conn: Requester,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const identity = conn.identity;
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return failure(undefined, "bad_request", "a request must be a JSON object");
  }
  const fields = frame as Record<string, unknown>;

  const rawId = fields["request_id"];
  const requestId = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;
  const op = fields["op"];
  if (typeof op !== "string") {
    return failure(requestId, "bad_request", "a request must carry an op name");
  }
  if (requestId === undefined) {
    return failure(undefined, "bad_request", "a request must carry a request_id");
  }

  // 1. the op is in the contract
  if (!isOpName(op)) {
    return failure(requestId, "unknown_op", `no such op: ${op}`);
  }
  const attrs = opAttributes(op);

  // 2. the arguments pass the op's schema
  const problems = validationErrors(OP_SCHEMAS[op].request, fields);
  if (problems.length > 0) {
    return failure(requestId, "invalid_args", problems.join("; "));
  }

  // The carrier the table names. An op marked `http` sets or reads a cookie,
  // which a frame on an open connection cannot, so it is reachable only where
  // the carrier can do that — and one arriving here is a caller that would be
  // answered without the half of the answer that matters (contract,
  // `OpAttributes.carrier`).
  if (attrs.carrier === "http") {
    return failure(requestId, "bad_request", `${op} is reached over HTTP, not on a connection`);
  }

  // 3. the identity `hello` settles, when the op needs one
  if (attrs.needs_hello && identity.state !== "settled") {
    return failure(requestId, "hello_required", `${op} needs an identity settled by hello`);
  }

  // 4. the connection's role is one the op allows. An anonymous connection has
  // no role to compare, and the ops it may reach (`needs_hello: false`) are
  // open to every role, so there is nothing to refuse here.
  if (identity.state === "settled" && !isRoleAllowed(op, identity.role)) {
    return failure(requestId, "forbidden", `${op} is not open to ${identity.role}`);
  }

  // 5. the capability the op declares, when it declares one
  if (attrs.capability !== undefined && !deps.capabilities.has(attrs.capability)) {
    return failure(
      requestId,
      "capability_unavailable",
      `${op} needs the ${attrs.capability} capability, which this instance does not have`,
    );
  }

  // 6. an instance-local op whose subject belongs elsewhere goes to mesh.
  //
  // A request that has already been here is dropped before that: a cycle in
  // the routing would otherwise send it round the same instances until every
  // deadline expired (§7.3). It is answered rather than left unanswered,
  // because the caller learns the same thing sooner and the code is the one
  // the contract gives a destination that could not be reached.
  const hops = fields["hops"];
  if (Array.isArray(hops) && hops.includes(deps.self)) {
    return failure(requestId, "instance_unreachable", `${op} came back to ${deps.self}`);
  }
  if (attrs.locality === "instance-local") {
    const asked = fields["to_instance"];
    const target = typeof asked === "string" ? asked : deps.resolveInstance(op, fields);
    if (target !== undefined && target !== deps.self) {
      return { kind: "forward", to: target, frame: fields };
    }
  }

  // 7. the implementation, which starts from "validated and allowed"
  try {
    const body = await deps.handlers[op]({
      op,
      args: fields,
      conn,
      identity: identity.state === "settled" ? identity : undefined,
      // The one route by which a role reaches an implementation (§3.2).
      role: attrs.scope === "role" && identity.state === "settled" ? identity.role : undefined,
    });
    return reply(requestId, body);
  } catch (cause) {
    if (cause instanceof OpError) return failure(requestId, cause.code, cause.message);
    // Anything else is the implementation failing for a reason that is not the
    // caller's: the arguments passed the op's schema and the call was allowed,
    // so re-reading the arguments would tell the caller nothing.
    return failure(requestId, "internal_error", `the op failed: ${String(cause)}`);
  }
}
