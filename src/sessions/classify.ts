import type { SessionState, Timestamp } from "@ccmsg/protocol";

/** What the harness's own row says, for a session that has one. */
export interface HarnessPresence {
  /** Its status is `waiting`, so a dialog is open (§5.1). */
  waiting: boolean;
  /** The terminal it runs in, when one could be read. Absent means unknown,
   * which is what makes a live session unmanaged. */
  terminal_id?: string;
}

/** Everything the classification reads, and nothing else (§5.1).
 *
 * Two of these are holes rather than values today: no gateway events are taken
 * in, so `gateway_active_at` is always absent, and no transcript is folded, so
 * `api_error_stopped` is always absent. Both are inputs, so filling them
 * changes no rule here. */
export interface SessionInputs {
  /** A connection of this session is open to us right now. */
  connected: boolean;
  /** Present when the harness's `sessions/` has a row for it. */
  harness?: HarnessPresence;
  /** The last time the gateway saw inference for it (§5.1, not taken in yet). */
  gateway_active_at?: Timestamp;
  /** Its transcript's last turn ended on an API error (not folded yet). */
  api_error_stopped?: boolean;
  /** Present when it is in `last_live`. */
  last_live?: { stopped_at?: Timestamp };
}

/** How recently the gateway must have seen a session for that alone to count
 * as being alive. Only reached once gateway events arrive. */
export const GATEWAY_LIVE_WINDOW_MS = 5 * 60 * 1000;

/** The classification is the contract's `SessionState`, derived here rather
 * than by whoever displays it (§5.2): a client combining raw values of its own
 * would read two instances' lists by two rules.
 *
 * Pinned is not one of them. A person pins a row and the instance holds the
 * mark beside the classification, but the mark never decides which state the
 * row is in (§5.2).
 *
 * Busy and idle are not among them either, and not by omission: a live session
 * carries how busy it is as an attribute of its row, so an instance with no
 * gateway configured loses that attribute and none of these sections.
 *
 * Undefined is the session no section holds: never seen live and not in
 * `last_live`, which is what a sid nobody has heard of looks like. */
export function classify(
  inputs: SessionInputs,
  now: Timestamp = Date.now(),
): SessionState | undefined {
  const live =
    inputs.connected ||
    inputs.harness !== undefined ||
    (inputs.gateway_active_at !== undefined &&
      now - inputs.gateway_active_at <= GATEWAY_LIVE_WINDOW_MS);
  // Waiting only says something about a session that is there to wait: an
  // entry in last_live cannot be holding a dialog open.
  if (live && (inputs.harness?.waiting === true || inputs.api_error_stopped === true)) {
    return "waiting";
  }
  if (live) {
    const reachable = inputs.connected || inputs.harness?.terminal_id !== undefined;
    return reachable ? "live" : "live_unmanaged";
  }
  if (inputs.last_live === undefined) return undefined;
  return inputs.last_live.stopped_at === undefined ? "disappeared" : "paused";
}
