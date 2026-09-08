import {
  type Capability,
  type InstanceId,
  TOPIC_ATTRIBUTES,
  type TopicAttributes,
  type TopicKind,
  topicKind,
} from "@ccmsg/protocol";
import type { Requester } from "../dispatch/index.ts";
import { isSuppressed } from "./granularity.ts";

/** What a subscribe decided. `ok` and the three refusals the contract names
 * for the op, so the caller turns an outcome into an error without deciding
 * anything of its own. */
export type SubscribeOutcome = "ok" | "topic_unknown" | "forbidden" | "capability_unavailable";

/** One value on a topic, and the instance that produced it. */
export interface TopicValue {
  readonly instance: InstanceId;
  readonly data: unknown;
}

/** Whoever owns the values behind a kind of topic, driven by whether anyone is
 * listening.
 *
 * Subscription is the only thing that starts or stops it (daemon-v2 §6.3):
 * `start` runs when a topic goes from no subscribers to one, `stop` when it
 * goes back to none. Both are given the full topic name, because the resource
 * is per name — one tail per `transcript:<sid>`, not one per kind.
 *
 * `snapshot` is asked for the current value, because the owner is where the
 * current value lives (§3.3): the topic mechanism sees changes go past and a
 * change is not a value. For a topic whose frames are elements or an append,
 * the last change is one message or one chunk, while the current value is
 * every message or the tail as it now stands — only the owner can say it.
 * It answers one entry per originating instance, and none at all for a topic
 * with no value to state. */
export interface UpstreamResource {
  start(topic: string): void;
  stop(topic: string): void;
  snapshot(topic: string): readonly TopicValue[];
}

/** One instance's topics: subscribers, the way a value reaches them, and the
 * suppression every topic shares.
 *
 * There is no class per topic. A topic is a name, a set of connections and the
 * form of the last frame sent under it, so the whole of daemon-v2 §6.1 is this
 * one object and "this topic has no suppression" cannot happen (M5). What it
 * does not hold is the current value: that belongs to whoever owns it (§3.3),
 * and is asked for when a subscriber needs it. */
export class Topics {
  /** Subscribers per topic name. A connection appears in as many sets as it
   * has subscriptions, and leaves all of them when it closes (§6.3). */
  readonly #subscribers = new Map<string, Set<Requester>>();
  /** The form of the last frame sent, per topic name and then per originating
   * instance — the only thing suppression needs, and the only thing kept.
   * Per instance because a whole value from one instance does not replace
   * another's (§6.2), so neither does it make the other a repeat. */
  readonly #lastSent = new Map<string, Map<InstanceId, string>>();
  readonly #upstream = new Map<TopicKind, UpstreamResource>();

  constructor(
    private readonly self: InstanceId,
    private readonly capabilities: ReadonlySet<Capability>,
  ) {}

  /** Bind the resource that feeds a kind of topic. */
  attach(kind: TopicKind, resource: UpstreamResource): void {
    this.#upstream.set(kind, resource);
  }

  /** The one way a value reaches subscribers (§6.1).
   *
   * `instance` is where the value was produced: this instance for a value of
   * our own, and the originating peer for one mesh relayed to us, which the
   * frame carries onward unchanged (§7.4). */
  publish(topic: string, data: unknown, instance: InstanceId = this.self): void {
    const kind = topicKind(topic);
    if (kind === undefined) return;
    if (isSuppressed(kind)) {
      // The suppression, written once for every topic it applies to (M5). An
      // event topic passes it by rather than carrying its own version of it:
      // "the same as the last one" is not a reason to drop something whose
      // point is that it happened again.
      const wire = serialize(data);
      const sent = this.#sent(topic);
      if (sent.get(instance) === wire) return;
      sent.set(instance, wire);
    }
    const frame = this.#frame(topic, instance, data, false);
    for (const conn of this.#subscribers.get(topic) ?? []) conn.send(frame);
  }

  subscribe(conn: Requester, topic: string): SubscribeOutcome {
    const kind = topicKind(topic);
    if (kind === undefined) return "topic_unknown";
    // Read at the declared type rather than at the literal one the table
    // infers, so the two checks below are the table's rule and not this
    // topic's own row.
    const attrs: TopicAttributes = TOPIC_ATTRIBUTES[kind];
    const identity = conn.identity;
    // Who may hear a topic is the same question the op table answers for ops,
    // asked of the topic table (§11.2). A connection with no settled identity
    // has no role to compare, and cannot reach the op that gets here anyway.
    if (identity.state !== "settled" || !attrs.roles.includes(identity.role)) return "forbidden";
    if (attrs.capability !== undefined && !this.capabilities.has(attrs.capability)) {
      return "capability_unavailable";
    }

    let subscribers = this.#subscribers.get(topic);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.#subscribers.set(topic, subscribers);
      // Before the connection joins, so a value the resource produces while
      // starting is held rather than pushed as a change to a subscriber that
      // has not had its snapshot yet.
      this.#upstream.get(kind)?.start(topic);
    }
    if (!subscribers.has(conn)) {
      subscribers.add(conn);
      conn.onClose(() => this.unsubscribe(conn, topic));
    }
    // The owner states the current value. A topic with no owner attached yet
    // answers nothing, as does one with no value to state (§6.2, event), and
    // in both cases the subscriber starts at the next thing that happens.
    for (const value of this.#upstream.get(kind)?.snapshot(topic) ?? []) {
      conn.deferSend(this.#frame(topic, value.instance, value.data, true));
    }
    return "ok";
  }

  /** Drop one subscription. Repeating it changes nothing, which is what lets
   * the close listener and an explicit unsubscribe both end a subscription. */
  unsubscribe(conn: Requester, topic: string): SubscribeOutcome {
    const kind = topicKind(topic);
    if (kind === undefined) return "topic_unknown";
    const subscribers = this.#subscribers.get(topic);
    if (subscribers === undefined || !subscribers.delete(conn)) return "ok";
    if (subscribers.size > 0) return "ok";
    this.#subscribers.delete(topic);
    // Nothing is listening, so the resource stops. What it last sent is
    // forgotten with it: comparing against a frame from before the resource
    // stopped would suppress the first frame after it starts again.
    this.#lastSent.delete(topic);
    this.#upstream.get(kind)?.stop(topic);
    return "ok";
  }

  /** How many connections hold a subscription to a topic. */
  subscriberCount(topic: string): number {
    return this.#subscribers.get(topic)?.size ?? 0;
  }

  #sent(topic: string): Map<InstanceId, string> {
    const sent = this.#lastSent.get(topic) ?? new Map<InstanceId, string>();
    this.#lastSent.set(topic, sent);
    return sent;
  }

  /** The wire shape of a topic frame, built here and nowhere else so snapshot
   * and change cannot drift apart (§11.1). */
  #frame(topic: string, instance: InstanceId, data: unknown, snapshot: boolean): object {
    return snapshot
      ? { ev: "topic", topic, snapshot: true, instance, data }
      : { ev: "topic", topic, instance, data };
  }
}

/** The comparison behind suppression, in one place for every topic (M5).
 *
 * A topic payload is the JSON the frame will carry, so its serialized form is
 * exactly what a subscriber would receive: comparing that answers "would this
 * frame tell the subscriber anything new" without walking the value, and it
 * cannot disagree with what goes on the wire. It is sensitive to key order,
 * which is not a defect here — the values come from a domain that builds each
 * topic's payload in one place, so the same value serializes the same way. */
function serialize(data: unknown): string {
  return JSON.stringify(data ?? null);
}
