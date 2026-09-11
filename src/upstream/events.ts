import type { LlmRequestInfo, Sid, Timestamp } from "@ccmsg/protocol";

/** One request the gateway forwarded, in this contract's spelling, before the
 * instance decides whether its series is the session's main one.
 *
 * `main` is a verdict about a session's several series, so it needs the other
 * series to be made and cannot be read off one event (§3.5 renames, it does not
 * derive). `instance` is stamped by whoever publishes, since an event says
 * nothing about which instance received it. */
export type LlmRequestObservation = Omit<LlmRequestInfo, "main" | "instance">;

/** How the prompt cache actually worked for one request, as the gateway read it
 * off the answer's usage. The gateway's own closed vocabulary: a word outside
 * it is dropped rather than carried, so nothing downstream has to decide what
 * an unknown verdict means for a countdown. */
export type CacheResult = "hit" | "written" | "partial" | "none" | "unknown";

const CACHE_RESULTS: readonly CacheResult[] = ["hit", "written", "partial", "none", "unknown"];

function cacheResultOf(value: unknown): CacheResult | undefined {
  return CACHE_RESULTS.find((result) => result === value);
}

/** An answer the gateway saw close. It says inference for that session has
 * stopped running and when, and it carries the one thing only an answer knows:
 * whether the cache the request counted on was actually there. That verdict
 * belongs to a series, so the series is named too. */
export interface LlmResponseObservation {
  readonly sid: Sid;
  readonly at: Timestamp;
  readonly prefix?: string;
  readonly cache?: CacheResult;
  /** The instant of the request this is the answer to. A series has several
   * requests in flight, so it is what says which of them this verdict is
   * about. */
  readonly request_at?: Timestamp;
}

/** A keepalive the gateway raised into a conversation. Nothing here replays it;
 * what is read is the name of the promise it carries, so a later withdrawal can
 * be matched against it. On this notice the name is the signal's own `nonce`. */
export interface CacheKeepaliveObservation {
  readonly sid: Sid;
  readonly prefix?: string;
  readonly notice: string;
}

/** The gateway withdrawing a promised lifetime by name. `of` names one promise
 * and only that one: a series whose latest promise is a different name has been
 * extended by someone else since, and this notice says nothing about it. */
export interface CacheExpiredObservation {
  readonly sid: Sid;
  readonly prefix?: string;
  readonly of: string;
  readonly at: Timestamp;
}

/** One item of a posted batch, as this instance reads it.
 *
 * `ignored` is a kind the gateway sends that nothing here reads — kept apart
 * from `undefined`, which is an item that could not be understood at all. The
 * difference is the whole value of the log line: a batch of ignorable items is
 * the gateway working, a batch of unreadable ones is a schema that moved. */
export type GatewayItem =
  | {
      readonly kind: "request";
      readonly info: LlmRequestObservation;
      /** The name of the lifetime this request promised, when it promised one.
       * Kept beside the observation rather than inside it: it is how two
       * notices of the gateway's are matched to each other, and nothing a
       * client reads (§3.5). */
      readonly notice?: string;
    }
  | { readonly kind: "response"; readonly info: LlmResponseObservation }
  | { readonly kind: "keepalive"; readonly info: CacheKeepaliveObservation }
  | { readonly kind: "cache_expired"; readonly info: CacheExpiredObservation }
  | { readonly kind: "ignored" };

/** A kind the gateway posts that nothing here reads: its keepalive strategy
 * being held off for a session. It is named rather than reached as "not a
 * request", so a kind the gateway grows still arrives as unreadable and shows
 * up in the log. */
const IGNORED = new Set(["keepalive_paused"]);

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
  if (kind === "cache_keepalive") {
    const info = keepaliveOf(raw);
    // A signal that named no promise is still the gateway working: it is the
    // notice this instance has nothing to match later, not one it misread.
    return info === undefined ? { kind: "ignored" } : { kind: "keepalive", info };
  }
  if (kind === "cache_expired") {
    const info = expiredOf(raw);
    return info === undefined ? undefined : { kind: "cache_expired", info };
  }
  // The forwarding notice is the one kind that carries no mark, because it
  // existed before the others did. So it is a request by position, and only
  // when it names no kind at all: an item that names one and is not handled
  // above must not be read as a request whose fields happen to line up.
  if (kind !== undefined) return undefined;
  const info = requestOf(raw);
  if (info === undefined) return undefined;
  const notice = raw["cache_notice"];
  return {
    kind: "request",
    info,
    ...(typeof notice === "string" && notice !== "" ? { notice } : {}),
  };
}

function keepaliveOf(raw: Record<string, unknown>): CacheKeepaliveObservation | undefined {
  const sid = raw["session_id"];
  // On this notice the promise's name and the signal's own password are the
  // same value, stated under either field, so both are read as the one name.
  const notice = raw["cache_notice"] ?? raw["nonce"];
  if (typeof sid !== "string" || sid === "") return undefined;
  if (typeof notice !== "string" || notice === "") return undefined;
  return { sid, notice, ...seriesOf(raw) };
}

function expiredOf(raw: Record<string, unknown>): CacheExpiredObservation | undefined {
  const at = raw["ts"];
  const sid = raw["session_id"];
  const of = raw["of"];
  if (!isInstant(at) || typeof sid !== "string" || sid === "") return undefined;
  if (typeof of !== "string" || of === "") return undefined;
  return { sid, of, at, ...seriesOf(raw) };
}

/** The series half of a key, when the notice names one. */
function seriesOf(raw: Record<string, unknown>): { prefix?: string } {
  const prefix = raw["prefix"];
  return typeof prefix === "string" && prefix !== "" ? { prefix } : {};
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
  const cache = cacheResultOf(raw["cache"]);
  const requestAt = raw["request_ts"];
  return {
    sid,
    at,
    ...seriesOf(raw),
    ...(cache === undefined ? {} : { cache }),
    ...(isInstant(requestAt) ? { request_at: requestAt } : {}),
  };
}

/** A number that can be an instant on this wire. Rejecting a non-number is
 * what stops an ISO string from reaching a `*_at` field. */
function isInstant(value: unknown): value is Timestamp {
  return typeof value === "number" && Number.isFinite(value);
}
