import type { SessionRow } from "../topics/index.ts";
import {
  type InstanceId,
  LAST_LIVE_RETENTION_MS,
  PLAIN_TOPICS,
  type Sid,
  TOPIC_ATTRIBUTES,
  type Timestamp,
} from "@ccmsg/protocol";
import { Elements, type TopicValue } from "../topics/index.ts";

/** The rows of sessions the whole cluster is seen through.
 *
 * They are `element`-granular, and an element topic is relayable only when its
 * elements say whose they are: a row here names the instance that holds the
 * session, so two instances' rows stand side by side under one topic name the
 * way a whole value per instance does. `inbox` and `kv:<ns>` are elements of
 * the same granularity and are not relayed, because their elements carry no
 * such name — an `inbox` frame belongs to a session, not to an instance. */
const ROW_TOPICS: readonly string[] = ["peers", "agents"];

/** The topics a subscriber sees the whole cluster on.
 *
 * A per-instance whole is relayable by construction (§6.2): a frame replaces
 * its own instance's entries and leaves every other instance's alone, so
 * several instances can state the same topic name without colliding. The rows
 * above are relayable for the same reason read one element at a time. */
export const CLUSTER_TOPICS: readonly string[] = [
  ...PLAIN_TOPICS.filter((topic) => TOPIC_ATTRIBUTES[topic].granularity === "per_instance_whole"),
  ...ROW_TOPICS,
];

/** The one topic the mesh carries that the relay does not.
 *
 * It is `element`-granular and its elements are the instances' own, so it is
 * asked for as the instance rather than on a person's behalf, and folded into
 * the set this instance holds rather than held here (DR-0001 §2.6). */
export const AUTH_TOPIC = "auth.records";

export function isClusterTopic(topic: string): boolean {
  return CLUSTER_TOPICS.includes(topic);
}

/** Whether what a frame of this topic carries is rows to be merged rather than
 * a value to be replaced. */
function carriesRows(topic: string): boolean {
  return ROW_TOPICS.includes(topic);
}

/** The rows of one frame, under the field each topic names them in. A frame
 * that carries none is one there is nothing to merge from. */
function rowsOf(topic: string, data: unknown): readonly SessionRow[] {
  const field = (data as Record<string, unknown> | undefined)?.[topic];
  return Array.isArray(field) ? (field as SessionRow[]) : [];
}

export interface RelayDeps {
  /** Hand a relayed frame to this instance's own subscribers, under the
   * instance that produced it (§7.4). */
  readonly publish: (topic: string, data: unknown, instance: InstanceId) => void;
  /** The clock, so a test can move the retention window without waiting it
   * out. */
  readonly now?: () => Timestamp;
}

/** What the peers said, held on this instance so that losing a peer does not
 * empty the cluster view (§7.5).
 *
 * Two things live here and nowhere else: the last whole value each instance
 * stated per topic, and whether that instance can be reached right now. The
 * suppression table of the topic mechanism is not the place for either — it
 * is forgotten the moment a topic has no subscriber, while what a peer last
 * said has to outlive both the subscription and the link.
 *
 * The retention window is read rather than swept: nothing here runs on a
 * timer (M3), so a value past the window is dropped by the next read that
 * would have returned it. */
export class Relay {
  /** Per instance, the last whole value it stated per topic. */
  readonly #held = new Map<InstanceId, Map<string, unknown>>();
  /** The mark of §7.5: when this instance stopped being reachable. Absent
   * while it is reachable. */
  readonly #lostAt = new Map<InstanceId, Timestamp>();

  constructor(private readonly deps: RelayDeps) {}

  #now(): Timestamp {
    return (this.deps.now ?? Date.now)();
  }

  /** A frame a peer pushed on a topic this instance relays.
   *
   * `snapshot` marks the opening frame of a subscription, which carries the
   * whole of what its instance holds rather than what changed.
   *
   * `instance` is the one that produced the value, which is not always the
   * peer it arrived from: a mesh of three relays transitively, and the frame
   * names its origin the whole way. Held under that origin, and passed on
   * unchanged — recomputing it would put the same judgement in two places
   * (§7.4). */
  accept(instance: InstanceId, topic: string, data: unknown, snapshot = false): void {
    if (!isClusterTopic(topic)) return;
    this.#sweep();
    const held = this.#held.get(instance) ?? new Map<string, unknown>();
    this.#held.set(instance, held);
    if (!carriesRows(topic)) {
      held.set(topic, data);
      this.deps.publish(topic, data, instance);
      return;
    }
    // A frame of rows says what changed, so what is held is the rows merged
    // and what travels on is the part of it that said something. The same
    // comparison the mechanism makes of a whole value, made of one element
    // (M5) — and a frame left with no rows is not passed on at all, which is
    // what stops a peer's restatement from becoming a frame for every local
    // subscriber.
    // An opening frame is the whole of what its instance holds, so it is taken
    // as the list restated rather than as changes folded in: a row the peer no
    // longer has is gone from it and from nowhere else, and merging would leave
    // it here forever. What comes of that is the same kind of answer either
    // way — the rows that told this instance something, removals included.
    const rows = this.#rows(held, topic);
    const stated = rowsOf(topic, data);
    const news = snapshot ? rows.diff(stated) : rows.merge(stated);
    if (news.length > 0) this.deps.publish(topic, { [topic]: news }, instance);
  }

  /** The rows one instance has stated on a topic, made the first time it does. */
  #rows(held: Map<string, unknown>, topic: string): Elements {
    const rows = (held.get(topic) as Elements | undefined) ?? new Elements();
    held.set(topic, rows);
    return rows;
  }

  /** The link to this instance is gone. What it said is kept and marked,
   * because dropping it would empty the view until the instance comes back
   * and restates everything (§7.5). */
  lost(instance: InstanceId): void {
    if (!this.#lostAt.has(instance)) this.#lostAt.set(instance, this.#now());
    this.#sweep();
  }

  /** The link is back. The mark goes, and what it said stands until the
   * instance replaces it with the snapshot its subscriptions bring. */
  restored(instance: InstanceId): void {
    this.#lostAt.delete(instance);
  }

  /** Whether this instance is currently held as unreachable. */
  unreachable(instance: InstanceId): boolean {
    this.#sweep();
    return this.#lostAt.has(instance);
  }

  /** The current value of a relayed topic, one entry per instance that has
   * stated one. What a fresh local subscriber is handed beside this
   * instance's own snapshot. */
  snapshot(topic: string): readonly TopicValue[] {
    this.#sweep();
    const values: TopicValue[] = [];
    for (const [instance, held] of this.#held) {
      const data = held.get(topic);
      if (data === undefined) continue;
      // A topic of rows is held merged, and the opening frame of a topic is
      // its whole value — so what a fresh subscriber is handed is every row
      // that instance has stated, in one frame of the same shape as the ones
      // that follow it.
      values.push(
        carriesRows(topic)
          ? { instance, data: { [topic]: (data as Elements).rows() } }
          : { instance, data },
      );
    }
    return values;
  }

  /** Which instance a session belongs to, read from the cluster values the
   * peers stated (§7.3).
   *
   * `peers` names every session an instance holds, connected and lost alike,
   * and is checked first. A session whose greeting has not reached its
   * instance yet has no row there while the harness may already know of it, so
   * `agents` is checked next. Every row names its own instance rather than the
   * one that relayed it, so a row that travelled through a third instance
   * still points at the session's own. */
  owner(sid: Sid): InstanceId | undefined {
    this.#sweep();
    for (const topic of ROW_TOPICS) {
      for (const held of this.#held.values()) {
        const row = (held.get(topic) as Elements | undefined)
          ?.rows()
          .find((held) => held.sid === sid);
        if (row !== undefined) return row.instance;
      }
    }
    return undefined;
  }

  /** Drop what an instance said once it has been gone for the retention
   * window. The window is the contract's, shared with `last_live` and the
   * inbox: past it, everything the value would point at is gone too
   * (§7.5, DV-Q12). */
  #sweep(): void {
    const now = this.#now();
    for (const [instance, since] of this.#lostAt) {
      if (now - since <= LAST_LIVE_RETENTION_MS) continue;
      this.#lostAt.delete(instance);
      this.#held.delete(instance);
    }
  }

  /** What is held right now, so a test can state that a disconnected
   * instance's value is still there and that a swept one is not. */
  get retained(): { instances: number; marked: number } {
    this.#sweep();
    return { instances: this.#held.size, marked: this.#lostAt.size };
  }
}
