import type { LlmRequestInfo, Sid, Timestamp } from "@ccmsg/protocol";

/** One request the gateway forwarded, in this contract's spelling, before the
 * instance decides whether its series is the session's main one.
 *
 * `main` is a verdict about a session's several series, so it needs the other
 * series to be made and cannot be read off one event (§3.5 renames, it does not
 * derive). `instance` is stamped by whoever publishes, since an event says
 * nothing about which instance received it. */
export type LlmRequestObservation = Omit<LlmRequestInfo, "main" | "instance">;

/** An answer the gateway saw close. Only the two fields the sessions domain
 * reads: it says inference for that session has stopped running, and when. */
export interface LlmResponseObservation {
  readonly sid: Sid;
  readonly at: Timestamp;
}

/** One item of a posted batch, as this instance reads it.
 *
 * `ignored` is a kind the gateway sends that nothing here reads — kept apart
 * from `undefined`, which is an item that could not be understood at all. The
 * difference is the whole value of the log line: a batch of ignorable items is
 * the gateway working, a batch of unreadable ones is a schema that moved. */
export type GatewayItem =
  | { readonly kind: "request"; readonly info: LlmRequestObservation }
  | { readonly kind: "response"; readonly info: LlmResponseObservation }
  | { readonly kind: "ignored" };

/** Kinds the gateway posts beside the two above: a keepalive it wants replayed
 * into a session, and its keepalive strategy being held off for one. Neither
 * is read here. They are named rather than reached as "not a request", so a
 * kind the gateway grows still arrives as unreadable and shows up in the log. */
const IGNORED = new Set(["cache_keepalive", "keepalive_paused"]);

/** The fields whose name is the same on both sides, and whose value is already
 * this contract's unit — a count of seconds, or an instant in Unix ms. */
const SAME_NAME_NUMBERS = [
  "cache_ttl_secs",
  "cache_expires_at",
  "cache_count",
  "next_keepalive_at",
  "cache_until_count",
  "cache_breakeven_count",
] as const;

/** The instants the gateway names without the suffix this contract requires of
 * every field that is a point in time. Renamed here, at the boundary, so
 * nothing downstream sees the gateway's spelling (§3.5). */
const RENAMED_INSTANTS = [
  ["cache_since", "cache_since_at"],
  ["cache_until", "cache_until_at"],
  ["cache_breakeven_until", "cache_breakeven_until_at"],
] as const;

const SAME_NAME_STRINGS = ["keepalive", "ns", "model", "credential", "origin"] as const;

/** Read one posted item.
 *
 * Nothing here throws: one item a batch could not be understood must not cost
 * the items beside it, so an unusable one is `undefined` and the caller drops
 * it. Every field is taken only when it is the type this contract states —
 * which is also what keeps a value the gateway might one day send in another
 * shape (an ISO instant, a string status) from travelling as itself. */
export function parseGatewayItem(value: unknown): GatewayItem | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const kind = raw["type"];
  if (typeof kind === "string" && IGNORED.has(kind)) return { kind: "ignored" };
  // A client that named no session gives an event with no row to put it on.
  // The gateway states the field as null rather than leaving it out, and this
  // is the ordinary case of a call made by something other than a session — so
  // it is passed over rather than counted as an event that could not be read.
  if (raw["session_id"] === null) return { kind: "ignored" };
  if (kind === "response") {
    const info = responseOf(raw);
    return info === undefined ? undefined : { kind: "response", info };
  }
  // The forwarding notice is the one kind that carries no mark, because it
  // existed before the others did. So it is a request by position, and only
  // when it names no kind at all: an item that names one and is not handled
  // above must not be read as a request whose fields happen to line up.
  if (kind !== undefined) return undefined;
  const info = requestOf(raw);
  return info === undefined ? undefined : { kind: "request", info };
}

function requestOf(raw: Record<string, unknown>): LlmRequestObservation | undefined {
  const at = raw["ts"];
  const sid = raw["session_id"];
  if (!isInstant(at) || typeof sid !== "string" || sid === "") return undefined;
  const info: Record<string, unknown> = { received_at: at, sid };
  const prefix = raw["prefix"];
  if (typeof prefix === "string" && prefix !== "") info["prefix"] = prefix;
  for (const field of SAME_NAME_NUMBERS) {
    const num = raw[field];
    if (typeof num === "number" && Number.isFinite(num)) info[field] = num;
  }
  for (const [there, here] of RENAMED_INSTANTS) {
    const num = raw[there];
    if (isInstant(num)) info[here] = num;
  }
  for (const field of SAME_NAME_STRINGS) {
    const text = raw[field];
    if (typeof text === "string" && text !== "") info[field] = text;
  }
  const paused = raw["cache_paused"];
  if (typeof paused === "boolean") info["cache_paused"] = paused;
  const status = raw["status"];
  if (typeof status === "number" && Number.isInteger(status)) info["status"] = status;
  return info as unknown as LlmRequestObservation;
}

function responseOf(raw: Record<string, unknown>): LlmResponseObservation | undefined {
  const at = raw["ts"];
  const sid = raw["session_id"];
  if (!isInstant(at) || typeof sid !== "string" || sid === "") return undefined;
  return { sid, at };
}

/** A number that can be an instant on this wire. Rejecting a non-number is
 * what stops an ISO string from reaching a `*_at` field. */
function isInstant(value: unknown): value is Timestamp {
  return typeof value === "number" && Number.isFinite(value);
}
