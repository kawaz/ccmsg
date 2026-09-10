import {
  type AgentInfo,
  type InstanceId,
  LAST_LIVE_RETENTION_MS,
  type LastLiveSession,
  type PeerInfo,
  PLAIN_TOPICS,
  type Sid,
  TOPIC_ATTRIBUTES,
  type Timestamp,
} from "@ccmsg/protocol";
import type { TopicValue } from "../topics/index.ts";

/** The topics a subscriber sees the whole cluster on.
 *
 * The per-instance whole is what makes a cluster view possible at all (§6.2):
 * a frame replaces its own instance's entries and leaves every other
 * instance's alone, so several instances can state the same topic name without
 * colliding. A topic of any other granularity has no such rule and is not
 * relayed — an `element` topic like `inbox` names one instance's topic while
 * its value belongs to a session, and a frame of it carries no way to say
 * whose it is. */
export const CLUSTER_TOPICS: readonly string[] = PLAIN_TOPICS.filter(
  (topic) => TOPIC_ATTRIBUTES[topic].granularity === "per_instance_whole",
);

/** The one topic the mesh carries that the relay does not.
 *
 * It is `element`-granular, so what travels is the entries that changed and the
 * receiver merges them by key; and it is the instances' own, so it is asked for
 * as the instance rather than on a person's behalf (DR-0001 §2.6). */
export const AUTH_TOPIC = "auth_records";

export function isClusterTopic(topic: string): boolean {
  return CLUSTER_TOPICS.includes(topic);
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
   * `instance` is the one that produced the value, which is not always the
   * peer it arrived from: a mesh of three relays transitively, and the frame
   * names its origin the whole way. Held under that origin, and passed on
   * unchanged — recomputing it would put the same judgement in two places
   * (§7.4). */
  accept(instance: InstanceId, topic: string, data: unknown): void {
    if (!isClusterTopic(topic)) return;
    this.#sweep();
    const held = this.#held.get(instance) ?? new Map<string, unknown>();
    this.#held.set(instance, held);
    held.set(topic, data);
    this.deps.publish(topic, data, instance);
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
      if (data !== undefined) values.push({ instance, data });
    }
    return values;
  }

  /** Which instance a session belongs to, read from the cluster values the
   * peers stated (§7.3).
   *
   * `peers` names every session an instance currently holds — connected or in
   * `last_live` — and is checked first. A session hello has not reached yet
   * has no row there but the harness may already know of it, so `agents` is
   * checked next; `last_live` is the last resort for one whose instance has
   * not stated `agents` at all. Every row names its own instance rather than
   * the one that relayed it, so a value that travelled through a third
   * instance still points at the session's own. */
  owner(sid: Sid): InstanceId | undefined {
    this.#sweep();
    for (const held of this.#held.values()) {
      const value = held.get("peers") as { peers?: PeerInfo[] } | undefined;
      const row = value?.peers?.find((peer) => peer.sid === sid);
      if (row !== undefined) return row.instance;
    }
    for (const held of this.#held.values()) {
      const value = held.get("agents") as { agents?: AgentInfo[] } | undefined;
      const row = value?.agents?.find((agent) => agent.sid === sid);
      if (row !== undefined) return row.instance;
    }
    for (const held of this.#held.values()) {
      const value = held.get("peers") as { last_live?: LastLiveSession[] } | undefined;
      const row = value?.last_live?.find((session) => session.sid === sid);
      if (row !== undefined) return row.instance;
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
