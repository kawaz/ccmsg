import {
  type Capability,
  type InstanceId,
  type Sid,
  TOPIC_ATTRIBUTES,
  type TopicAttributes,
  type TopicKind,
  topicGranularity,
  topicKind,
} from "@ccmsg/protocol";
import type { Requester } from "../dispatch/index.ts";

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
 * with no value to state.
 *
 * The subscribing connection is handed to `snapshot` because one topic's
 * current value differs by who is asking: `inbox` names one topic for the
 * instance, and what is on it for a session is what was said to that session
 * (§4.3). Owners whose value is the same for everyone ignore the argument. */
export interface UpstreamResource {
  start(topic: string): void;
  stop(topic: string): void;
  snapshot(topic: string, conn: Requester): readonly TopicValue[];
}

/** The rest of the cluster, as the topic mechanism sees it (§7.4).
 *
 * Two things, both about topics that carry a whole value per instance: what
 * the other instances have already stated, and whether anyone here is
 * listening — because what a subscriber asks of this instance is what this
 * instance asks of its peers. The mesh implements it; an instance without one
 * has no other instance to hear from. */
export interface RemoteTopics {
  snapshot(topic: string): readonly TopicValue[];
  demand(topic: string, wanted: boolean): void;
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
  /** The connections a close listener has already been registered on. Weak
   * because the entry says nothing once the connection is gone. */
  readonly #closers = new WeakSet<Requester>();

  constructor(
    private readonly self: InstanceId,
    private readonly capabilities: ReadonlySet<Capability>,
    private readonly remote?: RemoteTopics,
  ) {}

  /** Bind the resource that feeds a kind of topic. */
  attach(kind: TopicKind, resource: UpstreamResource): void {
    this.#upstream.set(kind, resource);
  }

  /** The one way a value reaches subscribers (§6.1).
   *
   * `instance` is where the value was produced: this instance for a value of
   * our own, and the originating peer for one mesh relayed to us, which the
   * frame carries onward unchanged (§7.4).
   *
   * `to` narrows the frame to the connections of one session. It exists for
   * `inbox`, whose topic name is one for the instance while its value belongs
   * to a session: without it, delivering to one session would push the message
   * to every subscriber. It changes who receives the frame and nothing else —
   * the frame, and the suppression before it, are the same ones every topic
   * goes through (M5). */
  publish(topic: string, data: unknown, instance: InstanceId = this.self, to?: Sid): void {
    const kind = topicKind(topic);
    if (kind === undefined) return;
    if (replaces(topic)) {
      // The suppression, written once for every topic it applies to (M5). The
      // contract's granularity is the whole of the rule, and only a frame that
      // replaces the value it repeats can be dropped for repeating it: a delta
      // is an occurrence — an inbox message offered again, a `kv` entry
      // restated — and dropping it would lose the offer, not a duplicate.
      const wire = serialize(data);
      const sent = this.#sent(topic);
      if (sent.get(instance) === wire) return;
      sent.set(instance, wire);
    }
    const frame = this.#frame(topic, instance, data, false);
    for (const conn of this.#subscribers.get(topic) ?? []) {
      if (holds(conn, to)) conn.send(frame);
    }
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
      // The subscription travels with the same trigger the local resource has:
      // one listener starts it, none stops it (§6.3, §7.4).
      this.remote?.demand(topic, true);
    }
    if (!subscribers.has(conn)) {
      subscribers.add(conn);
      // One listener for the connection rather than one per subscription: a
      // client that subscribes and unsubscribes as it moves between views does
      // so any number of times on one connection, and a listener registered
      // per subscription would be kept for every one of them until it closed.
      // What the single listener releases is every subscription still held,
      // which is what a close means (§6.3).
      if (!this.#closers.has(conn)) {
        this.#closers.add(conn);
        conn.onClose(() => this.dropAll(conn));
      }
    }
    // The owner states the current value. A topic with no owner attached yet
    // answers nothing, as does one with no value to state (§6.2, event), and
    // in both cases the subscriber starts at the next thing that happens.
    for (const value of this.#upstream.get(kind)?.snapshot(topic, conn) ?? []) {
      conn.deferSend(this.#frame(topic, value.instance, value.data, true));
    }
    // What the other instances last stated, under their own names. A whole
    // value per instance means the subscriber folds these beside ours instead
    // of choosing between them (§6.2), and an instance that has gone is still
    // among them until its value is given up (§7.5).
    for (const value of this.remote?.snapshot(topic) ?? []) {
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
    this.remote?.demand(topic, false);
    return "ok";
  }

  /** Drop every subscription one connection holds.
   *
   * What shutdown calls (§8.5 step 2) before it tells the connections
   * anything: a resource runs while it has a listener (§6.3), so taking the
   * listeners away is what stops the upstream watches — through the same
   * `unsubscribe` a closing connection goes through, rather than a second way
   * to release the same thing. */
  dropAll(conn: Requester): void {
    const held: string[] = [];
    for (const [topic, subscribers] of this.#subscribers) {
      if (subscribers.has(conn)) held.push(topic);
    }
    for (const topic of held) this.unsubscribe(conn, topic);
  }

  /** How many connections hold a subscription to a topic, counting only those
   * of one session when `to` names one.
   *
   * What delivery asks before it publishes: a message reaches its session
   * through this topic or it does not reach it at all, so whether anyone is
   * listening for that session decides between handing it over and holding it
   * (§4.2). */
  subscriberCount(topic: string, to?: Sid): number {
    let count = 0;
    for (const conn of this.#subscribers.get(topic) ?? []) {
      if (holds(conn, to)) count += 1;
    }
    return count;
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

/** What a scoped topic names: the sid of `session_status:<sid>`, the session
 * of `transcript:<sid>`, the namespace of `kv:<ns>`. Which kind of topic it is
 * has already been decided by whoever holds the name; this reads the parameter
 * out of it, in one place for every owner that is per name (§6.3). */
export function topicParam(topic: string): string | undefined {
  const separator = topic.indexOf(":");
  if (separator < 0) return undefined;
  const param = topic.slice(separator + 1);
  return param.length > 0 ? param : undefined;
}

/** Whether a connection is one of the session's, for a frame addressed to a
 * session. A connection with no sid settled holds none, so a person watching
 * the topic does not receive what was said to someone else. */
function holds(conn: Requester, to: Sid | undefined): boolean {
  if (to === undefined) return true;
  const identity = conn.identity;
  return identity.state === "settled" && identity.sid === to;
}

/** Whether a frame on this topic replaces the value it carries, which is the
 * question suppression asks (§6.1).
 *
 * The two whole-value granularities do: a payload equal to the last one leaves
 * the subscriber holding what it already holds. The others do not — an
 * `element` frame adds or restates one entry, an `append` frame carries a
 * chunk, an `event` frame is an occurrence — so two equal frames are two
 * things happening, and the second is news. */
function replaces(topic: string): boolean {
  const granularity = topicGranularity(topic);
  return granularity === "whole" || granularity === "per_instance_whole";
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
