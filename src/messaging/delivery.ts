import type {
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
import { type HandlerInput, OpError, type Requester } from "../dispatch/index.ts";
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

export interface DeliveryDeps {
  readonly self: InstanceId;
  readonly sessions: SessionLookup;
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
      throw new OpError("session_not_found", `no session ${to}`);
    }
    const message = this.#message(args, this.#sender(input));

    const direct = await this.deps.direct.send(to, message);
    if (direct === "delivered") return { delivered: true };
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
   * carries what was said to a session and they are not one. */
  snapshot(topic: string, conn: Requester): readonly TopicValue[] {
    const identity = conn.identity;
    const sid = identity.state === "settled" ? identity.sid : undefined;
    if (topic !== INBOX || sid === undefined) return [];
    const held = this.deps.inbox.undelivered(sid);
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
    if (from === USER_SENDER) return USER_SENDER;
    const peer = this.deps.sessions.peers().peers.find((row) => row.sid === from);
    if (peer === undefined) return from;
    const where = [peer.repo, peer.ws].filter((part) => part !== "").join("/");
    return where === "" ? from : where;
  }
}
