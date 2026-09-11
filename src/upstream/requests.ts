import {
  type InstanceId,
  llmCacheWindowEndAt,
  type LlmRequestInfo,
  type Sid,
  type Timestamp,
} from "@ccmsg/protocol";
import { GATEWAY_LIVE_WINDOW_MS } from "../sessions/index.ts";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";
import type { LlmRequestObservation } from "./events.ts";

export interface LlmRequestsDeps {
  readonly self: InstanceId;
  /** The one way a value reaches subscribers (§6.1). */
  readonly publish: (topic: string, data: unknown) => void;
  /** An event moved when a session was last seen running inference, which is
   * an input of the sessions domain (§5.1) and not of this topic. Told when
   * the window opened, which is the moment the classification can change. */
  readonly onActivity?: () => void;
  /** The same session seen again inside a window already open: one attribute
   * of one row moved. Told apart from the above because what it asks for is
   * that row restated rather than the whole domain recomputed. */
  readonly onMoved?: (sid: Sid) => void;
}

/** Which of a session's gateway facts moved.
 *
 * `live` is the moment the classification of §5.1 can change, because the
 * window either opened or closed, and the sessions domain recomputes for it.
 * `clock` is the same session seen again inside a window that was already open
 * — the value of an attribute, not a section anything is in — so what it asks
 * for is that one row restated. Both reach a subscriber; they differ in how
 * much work is done to say so. */
type GatewayMove = "live" | "clock" | "none";

/** Series remembered at once. The prune below already holds this near the
 * number active in the last cache window; the cap is what bounds a gateway
 * whose clock runs ahead, whose events would otherwise never expire. */
const MAX_SERIES = 500;

/** Prefixes whose session set is remembered. Sharing is a property of the
 * prefix and stays worth knowing after that series' window closes, but not
 * forever — the least recently seen go first. */
const MAX_PREFIXES = 2000;

/** One series' latest request, and when this session first used it. */
interface Series {
  info: LlmRequestObservation;
  /** Orders a session's series by when it started using them, which is the
   * tiebreak when it has several the sharing rule does not disqualify. */
  firstSeen: number;
}

/** What the gateway saw go upstream, per conversation series, and when each
 * session was last seen running inference.
 *
 * Keyed on the session and its series rather than on the session alone: a
 * session's subagents travel under its own id with a system prompt of their
 * own, so their cache windows are genuinely separate. Folding them together
 * would restart the session's countdown every time a subagent spoke.
 *
 * The frames carry the whole unexpired set rather than the series that just
 * moved, which is the topic's `per_instance_whole` granularity: a frame is the
 * whole of what this instance knows and replaces its share alone. It is what
 * lets a client that starts listening mid-window draw the countdown that began
 * before it was there. Nothing states an expiry: both sides compute it with the
 * contract's own `llmCacheWindowEndAt`, so a window closes at the same instant
 * here and on the screen. */
export class LlmRequests implements UpstreamResource {
  readonly #series = new Map<string, Series>();
  /** Prefix to the sessions it has been seen under, counted only as far as the
   * two it takes to prove sharing. */
  readonly #sidsByPrefix = new Map<string, Set<Sid>>();
  /** When each session was last seen running inference: the newest of its
   * requests and its answers. */
  readonly #activeAt = new Map<Sid, Timestamp>();
  #sequence = 0;

  constructor(private readonly deps: LlmRequestsDeps) {}

  /** Take one request the gateway forwarded.
   *
   * The newer of the two wins when a series already has one: events are
   * near-ordered in practice, but a redelivery can put an older one after a
   * newer, and a countdown must not walk backwards. */
  record(info: LlmRequestObservation): void {
    this.moved(info.sid, this.active(info.sid, info.received_at));
    const key = seriesKey(info.sid, info.prefix);
    const held = this.#series.get(key);
    if (held !== undefined && held.info.received_at >= info.received_at) return;
    this.notePrefix(info);
    // Removed before it is put back so the re-insert moves the series to the
    // end of the map's order, which is what makes the eviction below drop the
    // one seen least recently. `firstSeen` survives that move.
    this.#series.delete(key);
    this.#series.set(key, { info, firstSeen: held?.firstSeen ?? ++this.#sequence });
    while (this.#series.size > MAX_SERIES) {
      const oldest = this.#series.keys().next();
      if (oldest.done === true) break;
      this.#series.delete(oldest.value);
    }
    this.publish();
  }

  /** Take one answer the gateway saw close. It moves nothing on this topic —
   * the window belongs to the request that opened it — and only says the
   * session was still running inference at that instant. */
  note(sid: Sid, at: Timestamp): void {
    this.moved(sid, this.active(sid, at));
  }

  /** Tell whoever holds the row what this event moved for that session. */
  private moved(sid: Sid, move: GatewayMove): void {
    if (move === "live") this.deps.onActivity?.();
    else if (move === "clock") this.deps.onMoved?.(sid);
  }

  /** When the gateway last saw inference for a session (§5.1). Undefined once
   * that is old enough to say nothing about whether the session is alive. */
  activeAt(sid: Sid, now: Timestamp = Date.now()): Timestamp | undefined {
    const at = this.#activeAt.get(sid);
    if (at === undefined) return undefined;
    return now - at <= GATEWAY_LIVE_WINDOW_MS ? at : undefined;
  }

  /** Every series whose cache window is still open, each told whether it is
   * its session's main one. Prunes as it goes: a closed window is dropped
   * rather than re-sent forever. */
  entries(now: Timestamp = Date.now()): LlmRequestInfo[] {
    const live: Series[] = [];
    for (const [key, series] of this.#series) {
      if (llmCacheWindowEndAt(series.info) <= now) {
        this.#series.delete(key);
        continue;
      }
      live.push(series);
    }
    const main = this.#elect(live);
    return live.map((series) => ({
      ...series.info,
      instance: this.deps.self,
      main: main.get(series.info.sid) === series,
    }));
  }

  // --- UpstreamResource (§6.3). There is nothing to start: the events are
  // pushed to this instance whether or not anyone is listening, because the
  // sessions domain reads the same arrivals for a value of its own.

  start(): void {}

  stop(): void {}

  snapshot(): readonly TopicValue[] {
    return [{ instance: this.deps.self, data: this.entries() }];
  }

  private publish(): void {
    this.deps.publish("llm_requests", this.entries());
  }

  /** Note the session was seen, and say what that moved.
   *
   * A session already inside its window moves its clock and nothing else, so
   * the row it lands on is restated on its own: inference is observed several
   * times a second, and recomputing the domain for each would spend the whole
   * of that work on one attribute of one row (§5.2). */
  private active(sid: Sid, at: Timestamp): GatewayMove {
    const held = this.#activeAt.get(sid);
    if (held !== undefined && held >= at) return "none";
    const wasLive = held !== undefined && at - held <= GATEWAY_LIVE_WINDOW_MS;
    this.#activeAt.set(sid, at);
    // Sessions the gateway has not seen for longer than the window go: what is
    // left is what any of this can still say something about.
    this.prune(at);
    return wasLive ? "clock" : "live";
  }

  /** Drop the sessions whose window has closed. */
  private prune(now: Timestamp): void {
    const floor = now - GATEWAY_LIVE_WINDOW_MS;
    for (const [seen, when] of this.#activeAt) {
      if (when < floor) this.#activeAt.delete(seen);
    }
  }

  private notePrefix(info: LlmRequestObservation): void {
    const prefix = info.prefix;
    if (prefix === undefined) return;
    let sids = this.#sidsByPrefix.get(prefix);
    if (sids === undefined) {
      sids = new Set();
      this.#sidsByPrefix.set(prefix, sids);
      while (this.#sidsByPrefix.size > MAX_PREFIXES) {
        const oldest = this.#sidsByPrefix.keys().next();
        if (oldest.done === true) break;
        this.#sidsByPrefix.delete(oldest.value);
      }
    }
    if (sids.size < 2) sids.add(info.sid);
  }

  /** Which series is each session's own: the three steps the contract states
   * on `LlmRequestInfo.main`, in that order.
   *
   * Read from what is live right now rather than settled once, so an instance
   * that started while only a subagent was talking corrects itself the moment
   * that prefix appears under a second session. */
  #elect(live: readonly Series[]): Map<Sid, Series> {
    const stated = new Map<Sid, Series>();
    const statedSids = new Set<Sid>();
    for (const series of live) {
      if (series.info.origin === undefined) continue;
      statedSids.add(series.info.sid);
      if (series.info.origin !== "main") continue;
      // The newest rather than the first: a stated main series is legitimately
      // replaced, since a compaction rewrites the system prompt.
      const best = stated.get(series.info.sid);
      if (best === undefined || series.info.received_at > best.info.received_at) {
        stated.set(series.info.sid, series);
      }
    }

    const elected = new Map<Sid, Series>();
    for (const series of live) {
      if (statedSids.has(series.info.sid)) continue;
      if (this.shared(series.info.prefix)) continue;
      const best = elected.get(series.info.sid);
      if (best === undefined || series.firstSeen < best.firstSeen) {
        elected.set(series.info.sid, series);
      }
    }
    // Step 3. Two sessions opened on the same directory of the same repository
    // produce the same leading system block, so their own series share a prefix
    // and disqualify each other; the separation being given up here has nothing
    // left to separate.
    const fallback = new Map<Sid, Series>();
    for (const series of live) {
      const sid = series.info.sid;
      if (statedSids.has(sid) || elected.has(sid)) continue;
      const best = fallback.get(sid);
      if (best === undefined || series.info.received_at > best.info.received_at) {
        fallback.set(sid, series);
      }
    }
    for (const [sid, series] of fallback) elected.set(sid, series);
    for (const [sid, series] of stated) elected.set(sid, series);
    return elected;
  }

  private shared(prefix: string | undefined): boolean {
    if (prefix === undefined) return false;
    return (this.#sidsByPrefix.get(prefix)?.size ?? 0) > 1;
  }
}

/** The key of one conversation series.
 *
 * The first half is measured rather than delimited, so there is no character
 * that has to be impossible in a session id for two different pairs to stay
 * apart. A session whose gateway reports no series has one unnamed series,
 * which is what the absent half stands for. */
function seriesKey(sid: Sid, prefix: string | undefined): string {
  return `${sid.length}:${sid}${prefix ?? ""}`;
}
