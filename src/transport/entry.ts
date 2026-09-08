/** Who is allowed to reach this instance at all (daemon-v2 §3.1, "入口の許可").
 *
 * The checks themselves — a source-IP allowlist, the accepted Origin set, the
 * TLS a mesh peer presents — are config-driven and not implemented yet. The
 * hole is here so they land in transport, ahead of any frame, rather than being
 * discovered later as a check somewhere above. */
export interface EntryPolicy {
  /** Decide one incoming WS request before it is upgraded. */
  allowRequest?(request: Request): boolean;
}

/** Accepts everything. A listener given no policy is open to whatever can reach
 * the address it is bound to. */
export const OPEN: EntryPolicy = {};
