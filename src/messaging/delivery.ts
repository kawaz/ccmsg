import type {
  CallerIdentity,
  CandidateSession,
  InboxMessage,
  InstanceId,
  LastLiveSession,
  MessageSendArgs,
  MessageSendResult,
  Mid,
  PeerInfo,
  Sender,
  SessionState,
  Sid,
  Timestamp,
  UndeliveredReason,
} from "@ccmsg/protocol";
import { USER_SENDER } from "@ccmsg/protocol";
import {
  type DispatchResult,
  type HandlerInput,
  OpError,
  type Requester,
} from "../dispatch/index.ts";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";
import type { DirectRoute } from "./direct.ts";
import type { Inbox } from "./inbox.ts";

/** The topic a message reaches its session on, and the only route in use while
 * route (a) waits for confirmation (§4.1). */
const INBOX = "inbox";

/** What delivery reads about a session. Two questions, both answered by the
 * sessions domain from the inputs of §5.1: where a session stands, and which
 * sessions are around — neither is asked of anything else, which is what keeps
 * the reasons of §4.2 from growing a source per reason. */
export interface SessionLookup {
  classify(sid: Sid): SessionState | undefined;
  peers(): { peers: PeerInfo[]; last_live: LastLiveSession[] };
}

/** The rest of the cluster, for a message addressed outside this instance.
 *
 * `message_send` is a `cluster` op — any instance may be asked — but a message
 * reaches a session through the session's own connections, which are held by
 * the instance it greeted. So the op is answered here by carrying it there
 * (§3.2 step 6 is about `instance-local` ops; this is the same forwarding for
 * the one op whose subject is elsewhere while its op is not). */
export interface Cluster {
  /** Which instance holds this session, or nothing when the cluster has not
   * named it. */
  ownerOf(sid: Sid): InstanceId | undefined;
  /** Whether an instance that might hold it cannot be asked right now. */
  anyUnreachable(): boolean;
  /** Carry the op to that instance, run there as the caller named here. */
  forward(
    to: InstanceId,
    frame: Record<string, unknown>,
    caller: CallerIdentity | undefined,
  ): Promise<DispatchResult>;
}

export interface DeliveryDeps {
  readonly self: InstanceId;
  readonly sessions: SessionLookup;
  /** Absent on an instance with no mesh, where every session it can name is
   * its own. */
  readonly cluster?: Cluster;
  readonly inbox: Inbox;
  /** Route (a). Off until it is confirmed against a running harness, which is
   * condition 0 of §4.1 and is why this is handed in rather than built here. */
  readonly direct: DirectRoute;
  /** The one way a value reaches subscribers (§6.1), narrowed to the session a
   * message is for. */
  readonly publish: (topic: string, data: unknown, instance: InstanceId, to: Sid) => void;
  /** How many of that session's connections are listening on `inbox`. */
  readonly listeners: (topic: string, to: Sid) => number;
}

/** Delivery, and the inbox topic it delivers on (§4).
 *
 * Two things, as §4 splits them: the route a message takes, and what the sender
 * is told when it took none. The second reads the classification and the inbox
 * and nothing else (§4.2) — a reason is a name for a state that was already
 * there, never a state of its own. */
export class Delivery implements UpstreamResource {
  #counter: number;

  /** The sessions an offer is running for, so two of them cannot run at once
   * and send one message twice or send an older one after a newer. */
  readonly #offering = new Set<Sid>();

  /** The messages an offer has taken responsibility for, per session. They are
   * still in the inbox — an offer that does not reach the end leaves them
   * there — but they are spoken for, so the snapshot below hands them to
   * nobody: one message goes out on one route (§4.3). */
  readonly #claimed = new Map<Sid, Set<Mid>>();

  constructor(private readonly deps: DeliveryDeps) {
    this.#counter = deps.inbox.lastCounter(`${deps.self}/`);
  }

  /** `message_send`. The op fails only for a sid nobody knows; every other
   * outcome is a success carrying what became of the message. */
  send = async (input: HandlerInput): Promise<MessageSendResult> => {
    const args = input.args as unknown as MessageSendArgs;
    const to = args.to;
    const state = this.deps.sessions.classify(to);
    if (state === undefined) {
      const elsewhere = await this.#elsewhere(to, input);
      if (elsewhere !== undefined) return elsewhere;
      throw new OpError("session_not_found", `no session ${to}`);
    }
    const message = this.#message(args, this.#sender(input));

    const direct = await this.deps.direct.send(to, message);
    if (direct === "delivered") {
      // Route (a) reaching this session is the session being able to receive,
      // which is what the inbox waits for (§4.3). Whatever is still held for it
      // is offered now, on the route that just worked.
      await this.#offer(to);
      return { delivered: true };
    }
    if (direct === "refused") {
      // Turned away for now, which is neither delivered nor undeliverable: it
      // waits in the inbox and is offered again (§4.4).
      this.deps.inbox.hold(to, message);
      return { delivered: false, reason: "throttled" };
    }

    if (this.deps.listeners(INBOX, to) > 0) {
      this.deps.publish(INBOX, [message], this.deps.self, to);
      return { delivered: true };
    }

    const { evicted } = this.deps.inbox.hold(to, message);
    return this.#undelivered(to, evicted ? "inbox_full" : this.#reason(state));
  };

  /** A session this instance does not hold: carried to the instance that does,
   * or named as one the cluster cannot answer for right now.
   *
   * Nothing when the cluster has no such session anywhere and every instance
   * could be asked — which is the only case `session_not_found` covers (§4.2).
   * While an instance is out of reach the sid may well be its, so the sender is
   * told the reason rather than that the session does not exist. The message is
   * not held here either: the inbox that would offer it again is the one on the
   * instance that owns the session (§4.3). */
  async #elsewhere(to: Sid, input: HandlerInput): Promise<MessageSendResult | undefined> {
    const cluster = this.deps.cluster;
    if (cluster === undefined) return undefined;
    const owner = cluster.ownerOf(to);
    if (owner === undefined || owner === this.deps.self) {
      return cluster.anyUnreachable()
        ? { delivered: false, reason: "instance_unreachable" }
        : undefined;
    }
    // The sender, as the owning instance will run the op as: the identity the
    // connection greeted with, which is the same thing `message_send` reads to
    // decide who a message is from (§4.1).
    const answer = await cluster.forward(owner, input.args, callerOf(input));
    if (answer.kind === "reply") {
      const { ok: _ok, request_id: _id, ...body } = answer.response;
      return body as unknown as MessageSendResult;
    }
    if (answer.kind === "error" && answer.response.error.code === "instance_unreachable") {
      return { delivered: false, reason: "instance_unreachable" };
    }
    // Anything else is the owning instance refusing the op itself, and the
    // refusal is its to state.
    throw new OpError(
      answer.kind === "error" ? answer.response.error.code : "internal_error",
      answer.kind === "error" ? answer.response.error.msg : `${owner} did not answer`,
    );
  }

  /** Offer what is held to every session that might take it now.
   *
   * Called where the sessions domain says something about a session changed:
   * one of the things that can have changed is a session being live again, and
   * a session that is back is one route (a) can be tried against. Sessions with
   * nothing waiting are not asked about, so the cost of a change nobody is owed
   * anything after is one map read. */
  retry = async (): Promise<void> => {
    for (const sid of this.deps.inbox.sids()) {
      const state = this.deps.sessions.classify(sid);
      if (state === undefined || state === "paused" || state === "disappeared") continue;
      await this.#offer(sid);
    }
  };

  /** Hand a session what it is owed, oldest first, over route (a).
   *
   * Stops at the first message the route does not carry, whatever it answered:
   * a refusal means the session is taking nothing more for now (§4.4), and an
   * unavailable route means route (b) is the one that applies — either way the
   * rest stay held, in order, for the next time this session becomes able to
   * receive. */
  async #offer(to: Sid): Promise<void> {
    if (this.#offering.has(to)) return;
    const held = this.deps.inbox.undelivered(to);
    if (held.length === 0) return;
    this.#offering.add(to);
    this.#claimed.set(to, new Set(held.map((message) => message.mid)));
    try {
      for (const message of held) {
        const outcome = await this.deps.direct.send(to, message);
        // Out of the inbox one at a time rather than in one batch at the end:
        // an offer interrupted partway through has still delivered what it
        // delivered, and a daemon killed here must not offer those again.
        if (outcome !== "delivered") break;
        this.#claimed.get(to)?.delete(message.mid);
        this.deps.inbox.delivered(to, [message.mid]);
      }
    } finally {
      this.#claimed.delete(to);
      this.#offering.delete(to);
    }
  }

  // --- UpstreamResource (§6.3)

  /** Nothing upstream to run: what is undelivered is already in hand, and the
   * messages that arrive later come through `send`. */
  start(): void {}

  stop(): void {}

  /** The current value of `inbox` for whoever subscribed: everything still
   * undelivered for that session (§6.2, element granularity — the snapshot is
   * every element, a later frame is one).
   *
   * Subscribing is receiving, so the snapshot empties the inbox: the frame is
   * queued on the connection before this returns, and a message the session has
   * been handed is not one that is still waiting for it (§4.3). A connection
   * with no session — a person watching — is handed nothing, because the topic
   * carries what was said to a session and they are not one.
   *
   * A message an offer over route (a) has claimed is left out: it is on its way
   * on the other route, and the session subscribing while that runs must not
   * make it two messages. */
  snapshot(topic: string, conn: Requester): readonly TopicValue[] {
    const identity = conn.identity;
    const sid = identity.state === "settled" ? identity.sid : undefined;
    if (topic !== INBOX || sid === undefined) return [];
    const claimed = this.#claimed.get(sid);
    const held = this.deps.inbox
      .undelivered(sid)
      .filter((message) => claimed?.has(message.mid) !== true);
    this.deps.inbox.delivered(
      sid,
      held.map((message) => message.mid),
    );
    return [{ instance: this.deps.self, data: held }];
  }

  /** The reason a message is waiting, named from the classification alone
   * (§4.2). `preparing` is the live session with nowhere to put it: it is there,
   * route (a) did not carry it, and nothing of its is listening yet.
   *
   * `instance_unreachable` is not here: it is the mesh's answer about an
   * instance, and this instance holds every session it can classify. */
  #reason(state: SessionState): UndeliveredReason {
    switch (state) {
      case "paused":
        return "paused";
      case "disappeared":
        return "disappeared";
      case "live":
      case "live_unmanaged":
      case "waiting":
        return "preparing";
    }
  }

  /** The answer for a message that went to the inbox. Candidates ride along
   * when the addressee is gone, since that is when sending somewhere else is
   * the sender's next move (§4.2). */
  #undelivered(to: Sid, reason: UndeliveredReason): MessageSendResult {
    if (reason !== "paused" && reason !== "disappeared") return { delivered: false, reason };
    const candidates = this.#candidates(to);
    return candidates.length === 0
      ? { delivered: false, reason }
      : { delivered: false, reason, candidates };
  }

  /** Sessions live now in the repository the addressee belongs to (§4.2).
   *
   * The repository is `repo_root` as the session named it. A session that named
   * none is left out rather than matched on something derived from its `cwd`:
   * no primary source states that derivation, and the sessions domain does not
   * make one up either. */
  #candidates(to: Sid): CandidateSession[] {
    const { peers, last_live } = this.deps.sessions.peers();
    const root = [...peers, ...last_live].find((row) => row.sid === to)?.repo_root;
    if (root === undefined) return [];
    return peers
      .filter((peer) => peer.sid !== to && peer.repo_root === root)
      .map((peer) => ({
        sid: peer.sid,
        ...(peer.ws === "" ? {} : { ws: peer.ws }),
        instance: peer.instance,
      }));
  }

  /** Who the message is from: the identity the connection greeted as, never
   * anything the caller put in the arguments (§4.1).
   *
   * A session names itself with its sid. A person greets without one, which is
   * what the sender literal stands for — spelled out so a reader tells "a
   * person sent this" from "a session sent this and the id was lost". The
   * absence is read rather than the role, because the op is open to those two
   * and no other, so a settled greeting with no sid is a person by elimination.
   * An unsettled connection names no sender at all, and a message with no
   * sender is one nobody can answer. */
  #sender(input: HandlerInput): Sender {
    const identity = input.identity;
    if (identity === undefined) {
      throw new OpError("bad_request", "a message is sent by a greeting, and this one made none");
    }
    return identity.sid ?? USER_SENDER;
  }

  #message(args: MessageSendArgs, from: Sender, now: Timestamp = Date.now()): InboxMessage {
    return {
      mid: this.#mid(),
      from,
      from_label: this.#label(from),
      text: args.text,
      ...(args.reply_to === undefined ? {} : { reply_to: args.reply_to }),
      sent_at: now,
    };
  }

  /** `<instance>/<counter>`, numbered by this instance. The counter starts
   * above the highest one a held message carries, so a restart cannot reissue a
   * `mid` that a `reply_to` still points at. */
  #mid(): Mid {
    this.#counter += 1;
    return `${this.deps.self}/${this.#counter}`;
  }

  /** How the sender is shown. The repository and workspace it greeted from,
   * which is what tells two sessions of one person apart; its sid when it
   * greeted from neither, so the label always names something. A person is
   * shown as the sender literal: there is one person per instance to a
   * session's eye, so there is nothing further to tell apart. */
  #label(from: Sender): string {
    return from === USER_SENDER ? USER_SENDER : sessionLabel(this.deps.sessions, from);
  }
}

/** Who is asking, as another instance is told it (contract, `CallerIdentity`).
 * A connection with no settled greeting names nobody, and `message_send`
 * refuses it before this is reached. */
function callerOf(input: HandlerInput): CallerIdentity | undefined {
  const identity = input.identity;
  if (identity === undefined) return undefined;
  return identity.sid === undefined
    ? { role: identity.role }
    : { role: identity.role, sid: identity.sid };
}

/** How a session is shown: the repository and workspace it greeted from, which
 * is what tells two sessions of one person apart, and its sid when it greeted
 * from neither so the label always names something.
 *
 * Written once for every label the instance resolves — a message's sender and a
 * notification's subject are the same session seen from two ops, and a session
 * shown one way there and another way here would read as two. */
export function sessionLabel(sessions: SessionLookup, sid: Sid): string {
  const peer = sessions.peers().peers.find((row) => row.sid === sid);
  if (peer === undefined) return sid;
  const where = [peer.repo, peer.ws].filter((part) => part !== "").join("/");
  return where === "" ? sid : where;
}
