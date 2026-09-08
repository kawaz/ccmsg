import type { InboxMessage, Sid } from "@ccmsg/protocol";

/** What route (a) answered (§4.1).
 *
 * `unavailable` is every way the route does not apply — the flag is off, the
 * harness names no messaging socket, the generation is one we do not speak, the
 * key cannot be read, the acknowledgement did not come. §4.1 gives them one
 * outcome on purpose: the route either carried the message or it did not, and
 * route (b) is tried the same way in each case.
 *
 * `refused` is separate because it is not "the route does not apply": the
 * session is there and turned this message away for now, which is the one
 * outcome that reaches the sender as its own reason (§4.4). */
export type DirectOutcome = "delivered" | "unavailable" | "refused";

/** Route (a): the harness's own messaging socket.
 *
 * An interface with one implementation, because the implementation is not
 * written: the protocol is unofficial and unverified against a running harness
 * (§4.1), so the shape is here and the behaviour waits. */
export interface DirectRoute {
  send(sid: Sid, message: InboxMessage): Promise<DirectOutcome>;
}

/** Route (a) with the feature flag off, which is its state until the protocol
 * is confirmed against a real harness (§4.1 condition 0).
 *
 * Delivery is unchanged by this: route (b) is the fallback, and a fallback that
 * always runs is still the same semantics (§4.1). */
export class DisabledDirectRoute implements DirectRoute {
  send(): Promise<DirectOutcome> {
    return Promise.resolve("unavailable");
  }
}
