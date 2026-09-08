import type { CallerIdentity, Sid } from "@ccmsg/protocol";
import type { ConnIdentity } from "./identity.ts";

/** A `caller` that cannot be read as an identity. */
export class CallerError extends Error {}

/** The identity a forwarded request names, or nothing when it names none
 * (contract, `CallerIdentity`).
 *
 * The role is read here because it decides which fields the value has to
 * carry — `sid` is present exactly when the role is `session` — and not
 * whether anything is allowed: what the identity may do is decided afterwards,
 * by dispatch, against the attribute table (§3.2). It is the same question
 * `hello` asks of a greeting, whose shape depends on its role in the same way
 * and for the same reason: one schema covers all three roles, so the schema
 * cannot state the rule and the instance does.
 *
 * A violation is refused rather than trimmed. A `caller` naming a role of
 * `user` and a sid describes two different callers, and picking either would
 * run the op as somebody nobody asked for. */
export function callerOf(frame: unknown): CallerIdentity | CallerError | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const stated = (frame as Record<string, unknown>)["caller"];
  if (stated === undefined) return undefined;
  if (typeof stated !== "object" || stated === null) {
    return new CallerError("a caller is an object naming a role");
  }
  const { role, sid } = stated as { role?: unknown; sid?: unknown };
  if (role !== "session" && role !== "user" && role !== "instance") {
    return new CallerError("a caller names one of the contract's roles");
  }
  if ((role === "session") !== (typeof sid === "string")) {
    return new CallerError("a caller carries a sid when, and only when, it is a session");
  }
  return role === "session" ? { role, sid: sid as Sid } : { role };
}

/** How a connection of this instance's own is named to another instance.
 *
 * An anonymous connection names nobody: the ops it can reach before `hello`
 * are answered where they are asked, so there is nothing of it to forward. */
export function callerOfIdentity(identity: ConnIdentity): CallerIdentity | undefined {
  if (identity.state !== "settled") return undefined;
  return identity.sid === undefined
    ? { role: identity.role }
    : { role: identity.role, sid: identity.sid };
}
