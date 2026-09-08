/** Who is allowed to reach this instance at all (daemon-v2 §3.1, "入口の許可").
 *
 * Two questions, because they are asked of different things. `allowRequest`
 * runs for every HTTP request the listener takes, the routed ones included, and
 * answers "may this address, presenting this `Origin`, speak to us at all".
 * `allowUpgrade` runs only for the WebSocket handshake and answers "does this
 * handshake carry the instance's entry token" — a route that carries its own
 * secret is not asked for a second one.
 *
 * The checks are config-driven and the instance supplies them; transport only
 * asks, so no policy is written into the listener. */
export interface EntryPolicy {
  /** Decide one incoming request before anything is done with it.
   *
   * `source` is the peer address the server observed. It is passed rather than
   * read off the request because a forwarding header is written by whoever is
   * in front of us, and this allowlist is about who actually connected. */
  allowRequest?(request: Request, source: string | undefined): boolean;
  /** Decide the WebSocket handshake itself. */
  allowUpgrade?(request: Request): UpgradeDecision;
}

/** The handshake's answer. `protocol` is the subprotocol to select, which the
 * handshake must echo when the client offered any: a browser fails a connection
 * whose reply names none of what it asked for. */
export type UpgradeDecision =
  | {
      readonly ok: true;
      readonly protocol?: string;
      /** Let in as a peer rather than on the entry token. Such a connection has
       * shown nothing yet: what it is gets decided by the mesh handshake, so
       * until that finishes it may do only the one thing that can decide it. */
      readonly mesh?: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** Accepts everything. A listener given no policy is open to whatever can reach
 * the address it is bound to. */
export const OPEN: EntryPolicy = {};

/** The subprotocol a WebSocket client carries its entry token in.
 *
 * A browser cannot put a header on a WebSocket handshake, and the subprotocol
 * list is the one field it can set, so the token travels as one of its values.
 * A query parameter is accepted beside it for clients that are not browsers. */
export const TOKEN_PROTOCOL = "ccmsg.token.";

/** The query parameter that carries the same token. */
export const TOKEN_PARAM = "token";
