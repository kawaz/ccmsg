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
import { Egress, type EgressOptions } from "./egress.ts";

/** What publishing a frame decided.
 *
 * `rate_limited` is one subscriber's outgoing queue refusing it: the topic is
 * one whose frames cannot be folded, and that terminal is already holding as
 * many as it may. Whoever raised the value is told, because it is the only
 * party that can stop raising more (§6.4). */
export type PublishOutcome = "ok" | "rate_limited";

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
 * (§4.3). Owners whose value is the same for everyone ignore the argument.
 *
 * An owner whose value has to be read before it can be stated answers with a
 * promise, and the subscription is not answered until it settles (CT-Q8): a
 * subscriber is told what a value is or waits to be told, and never told an
 * empty one that means something else. An owner already holding its value
 * answers with it directly, and the wait is then no wait at all. */
export interface UpstreamResource {
  start(topic: string): void;
  stop(topic: string): void;
  snapshot(topic: string, conn: Requester): readonly TopicValue[] | Promise<readonly TopicValue[]>;
}

/** The rest of the mesh, as the topic mechanism sees it (§7.4).
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
  /** The subscriptions whose opening value is still being read, per topic name.
   *
   * A connection is here and not among the subscribers while it waits: it is
   * not sent what happens during the wait (that is what its snapshot is for),
   * and it is what keeps the resource running for a topic nobody is listening
   * to yet. An unsubscribe or a close during the wait takes the connection out
   * of here, which is how the wait learns that its subscription is gone. */
  readonly #opening = new Map<string, Set<Requester>>();
  /** The connections a close listener has already been registered on. Weak
   * because the entry says nothing once the connection is gone. */
  readonly #closers = new WeakSet<Requester>();
  /** The outgoing queue of each terminal that holds a subscription (§6.4).
   * One per connection rather than one per topic: what a socket can absorb is
   * the connection's, and the folding needs every topic's frames in one place
   * to keep their order among each other. */
  readonly #egress = new Map<Requester, Egress>();

  constructor(
    private readonly self: InstanceId,
    private readonly capabilities: ReadonlySet<Capability>,
    private readonly remote?: RemoteTopics,
    private readonly egressOptions: EgressOptions = {},
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
   * `to` narrows the frame to an audience. It exists for `inbox`, whose topic
   * name is one for the instance while its value belongs to a session: without
   * it, delivering to one session would push the message to every subscriber.
   * A sid means that session's own connections, since the session's
   * subscription is the delivery itself. `PEOPLE` means whoever is watching
   * from outside, whose subscription is a view of what is waiting rather than
   * a delivery — so the same inbox is stated to the two audiences separately,
   * each in the terms that audience reads it in. It changes who receives the
   * frame and nothing else — the frame, and the suppression before it, are the
   * same ones every topic goes through (M5).
   *
   * The frame reaches each subscriber through that terminal's outgoing queue
   * (§6.4) rather than the socket directly, so a value restated faster than a
   * reader can take it leaves one frame carrying the latest of it. `ok` means
   * every subscriber took the frame; `rate_limited` means at least one refused
   * it, which only a topic whose frames do not fold can do. */
  publish(
    topic: string,
    data: unknown,
    instance: InstanceId = this.self,
    to?: Audience,
  ): PublishOutcome {
    const kind = topicKind(topic);
    if (kind === undefined) return "ok";
    if (replaces(topic)) {
      // The suppression, written once for every topic it applies to (M5). The
      // contract's granularity is the whole of the rule, and only a frame that
      // replaces the value it repeats can be dropped for repeating it: a delta
      // is an occurrence — an inbox message offered again, a `kv` entry
      // restated — and dropping it would lose the offer, not a duplicate.
      const wire = serialize(data);
      const sent = this.#sent(topic);
      if (sent.get(instance) === wire) return "ok";
      sent.set(instance, wire);
    }
    const frame = this.#frame(topic, instance, data, false);
    // What the queue folds on is what the contract says a frame does to the
    // value before it: a frame that replaces one instance's value supersedes
    // the one waiting under that instance's name, and nothing else does. The
    // rule is the same one suppression asks, read in one place (M5).
    const fold = replaces(topic) ? `${topic}\u0000${instance}` : undefined;
    let outcome: PublishOutcome = "ok";
    for (const conn of this.#subscribers.get(topic) ?? []) {
      if (!holds(conn, to)) continue;
      if (!this.#out(conn).push(frame, fold)) outcome = "rate_limited";
    }
    return outcome;
  }

  /** Take a subscription, answering once the topic's current value is in hand.
   *
   * The wait is the owner's: a value that has to be read is read before this
   * answers, and everything else on the connection goes on in the meantime,
   * since nothing here serialises one request behind another. */
  async subscribe(conn: Requester, topic: string): Promise<SubscribeOutcome> {
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

    // One listener for the connection rather than one per subscription: a
    // client that subscribes and unsubscribes as it moves between views does
    // so any number of times on one connection, and a listener registered per
    // subscription would be kept for every one of them until it closed. What
    // the single listener releases is every subscription still held, which is
    // what a close means (§6.3). It goes on before the wait, so a connection
    // that closes during one is released by it.
    if (!this.#closers.has(conn)) {
      this.#closers.add(conn);
      conn.onClose(() => this.dropAll(conn));
    }
    const started =
      this.#subscribers.get(topic) !== undefined || this.#opening.get(topic) !== undefined;
    const opening = this.#opening.get(topic) ?? new Set<Requester>();
    this.#opening.set(topic, opening);
    opening.add(conn);
    if (!started) {
      // The resource runs from the first want, and an opening subscription is
      // one: what it is being asked for is the resource's own value.
      this.#upstream.get(kind)?.start(topic);
      // The subscription travels with the same trigger the local resource has:
      // one listener starts it, none stops it (§6.3, §7.4).
      this.remote?.demand(topic, true);
    }
    // The owner states the current value. A topic with no owner attached yet
    // answers nothing, as does one with no value to state (§6.2, event), and
    // in both cases the subscriber starts at the next thing that happens.
    let stated: readonly TopicValue[];
    try {
      stated = (await this.#upstream.get(kind)?.snapshot(topic, conn)) ?? [];
    } catch (failure) {
      // No value came back, so there is no subscription: the connection was
      // never among the subscribers, and what was started for it stops unless
      // somebody else still wants it. The failure is the caller's answer.
      opening.delete(conn);
      this.#idle(kind, topic);
      throw failure;
    }
    // Gone while the value was being read — an unsubscribe, or a close. The
    // snapshot is not sent and the connection does not join: what it asked for
    // it has since asked to be let out of (DR-0015 §2.5).
    if (!opening.delete(conn)) {
      this.#idle(kind, topic);
      return "ok";
    }
    let subscribers = this.#subscribers.get(topic);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.#subscribers.set(topic, subscribers);
    }
    // The connection joins only now, with its snapshot in hand: a frame raised
    // while it waited would otherwise have reached it before the value that
    // frame is a change to (§6.1).
    subscribers.add(conn);
    for (const value of stated) {
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
    // A subscription still being opened is dropped the same way one already
    // open is: the wait sees it is gone and neither sends the snapshot nor
    // joins the connection.
    const dropped = this.#opening.get(topic)?.delete(conn) === true;
    const subscribers = this.#subscribers.get(topic);
    if (subscribers?.delete(conn) !== true && !dropped) return "ok";
    this.#idle(kind, topic);
    return "ok";
  }

  /** Let a topic go once nothing wants it — neither a subscriber nor a
   * subscription still being opened. What it last sent is forgotten with it:
   * comparing against a frame from before the resource stopped would suppress
   * the first frame after it starts again. */
  #idle(kind: TopicKind, topic: string): void {
    const subscribers = this.#subscribers.get(topic);
    const opening = this.#opening.get(topic);
    // Already let go. Asking a resource to stop twice would take two of the
    // holds it counts, where only one was ever taken.
    if (subscribers === undefined && opening === undefined) return;
    if ((subscribers?.size ?? 0) > 0 || (opening?.size ?? 0) > 0) return;
    this.#subscribers.delete(topic);
    this.#opening.delete(topic);
    this.#lastSent.delete(topic);
    this.#upstream.get(kind)?.stop(topic);
    this.remote?.demand(topic, false);
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
    for (const [topic, opening] of this.#opening) {
      if (opening.has(conn) && !held.includes(topic)) held.push(topic);
    }
    for (const topic of held) this.unsubscribe(conn, topic);
    // Whatever was waiting for this terminal was raised while it was still
    // subscribed, so it goes out rather than being dropped, and nothing armed
    // for it stays behind.
    this.#egress.get(conn)?.release();
    this.#egress.delete(conn);
  }

  /** How many connections hold a subscription to a topic, counting only those
   * of one session when `to` names one.
   *
   * What delivery asks before it publishes: a message reaches its session
   * through this topic or it does not reach it at all, so whether anyone is
   * listening for that session decides between handing it over and holding it
   * (§4.2). */
  subscriberCount(topic: string, to?: Sid): number {
    // The session's own connections, never the people watching: what this
    // count decides is whether a message can be handed over, and a person
    // holding the view is not somewhere a message can be delivered.
    let count = 0;
    for (const conn of this.#subscribers.get(topic) ?? []) {
      if (holds(conn, to)) count += 1;
    }
    return count;
  }

  /** This terminal's outgoing queue, made the first time it is written to. */
  #out(conn: Requester): Egress {
    const held = this.#egress.get(conn);
    if (held !== undefined) return held;
    const made = new Egress(conn, this.egressOptions);
    this.#egress.set(conn, made);
    return made;
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

/** What a scoped topic names: the sid of `session.status:<sid>`, the session
 * of `transcript:<sid>`, the namespace of `kv:<ns>`. Which kind of topic it is
 * has already been decided by whoever holds the name; this reads the parameter
 * out of it, in one place for every owner that is per name (§6.3). */
export function topicParam(topic: string): string | undefined {
  const separator = topic.indexOf(":");
  if (separator < 0) return undefined;
  const param = topic.slice(separator + 1);
  return param.length > 0 ? param : undefined;
}

/** The people watching a topic, as an audience a frame can be narrowed to.
 *
 * A sid is the other kind, and there is no third: a frame is for the session a
 * value belongs to, or for whoever is looking at it from outside. */
export const PEOPLE: unique symbol = Symbol("people");

/** Who a narrowed frame is for: one session, or the people watching. */
export type Audience = Sid | typeof PEOPLE;

/** Whether a connection is among the audience a frame was narrowed to.
 *
 * A settled connection naming a sid is a session, and one naming none is
 * somebody watching — the two audiences, told apart by the same field that
 * already decides what a session receives rather than by a role this would be
 * a second reading of (M1). A topic narrowed this way is one the table lets no
 * other role subscribe to at all. Neither audience is told the other's
 * frames. */
function holds(conn: Requester, to: Audience | undefined): boolean {
  if (to === undefined) return true;
  const identity = conn.identity;
  if (identity.state !== "settled") return false;
  return to === PEOPLE ? identity.sid === undefined : identity.sid === to;
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
