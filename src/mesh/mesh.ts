import { hostname } from "node:os";
import {
  type CallerIdentity,
  type InstanceId,
  type InstanceInfo,
  PROTOCOL_VERSION,
  type Sid,
  type Timestamp,
} from "@ccmsg/protocol";
import { type Conn, type ConnRegistry, dialWs } from "../transport/index.ts";
import {
  type DispatchResult,
  failure,
  OpError,
  reply,
  type Requester,
  type SettledIdentity,
} from "../dispatch/index.ts";
import type { TopicValue } from "../topics/index.ts";
import { isClusterTopic, Relay } from "./relay.ts";
import {
  ALLOWED_ALGS,
  EphemeralKey,
  type MeshJwk,
  MESH_VER,
  parseProof,
  PROOF_LIFETIME_MS,
  ProofError,
  randomId,
  verifyProof,
} from "./keys.ts";
import { SelfIdentification } from "./identify.ts";
import {
  isProbePath,
  jwkEndpoint,
  type JwkRequest,
  type JwkResponse,
  kidOfPath,
  MESH_PROTOCOL,
  meshFrameOf,
  type ProbeBody,
  wsEndpoint,
} from "./wire.ts";

/** What a greeting claims, as the contract spells it. Taken as unknown fields
 * because nothing here trusts it until the proof lands (mesh-peer-auth §5.3). */
export interface MeshClaim {
  readonly ver: number;
  readonly iss: InstanceId;
  readonly aud: InstanceId;
  readonly kid: string;
}

/** The close code a glare loser is closed with.
 *
 * In the range WebSocket leaves to applications. It exists so the far end can
 * tell this closure from a fault: losing a glare is its normal course, and
 * reconnecting on it would reopen exactly the connection both sides just
 * agreed to drop (§8.1). */
export const GLARE_CLOSE = 4000;

/** How often a link is asked whether it is still there, and how long silence
 * may last before it is treated as gone.
 *
 * Provisional values: mesh-peer-auth §8.3 requires a heartbeat and states no
 * period, and no primary source gives one, so these are chosen rather than
 * derived. The reasoning behind the choice is that the heartbeat exists to
 * catch a silent drop by a middlebox, whose idle timeouts are conventionally
 * around a minute, and that three missed beats is the usual margin before a
 * link is called dead. Replace them with measured values when a deployment
 * gives any.
 *
 * This is the periodic timer this layer owns, and its whole justification (M3).
 * There is no other: reconnection is scheduled per failure rather than polled,
 * and reachability is read from the links rather than swept. */
export const HEARTBEAT_MS = 20_000;
export const HEARTBEAT_TIMEOUT_MS = 3 * HEARTBEAT_MS;

/** The reconnection backoff (§8.2).
 *
 * Loose on purpose: a peer that comes back dials us, so the moment it recovers
 * is signalled by its own start rather than found by our retries. What this
 * schedule is for is the case where only our side of the link failed. */
export const RECONNECT_MIN_MS = 5_000;
export const RECONNECT_MAX_MS = 60_000;

/** How many key requests are answered per second, over all callers.
 *
 * The key endpoint is reached before anything is proven (§6), so it is the one
 * surface an unauthenticated caller can make this instance do work on. The cap
 * is well above what a mesh of any size needs — one request per connection
 * established — and well below what would cost anything. */
const JWK_RATE_LIMIT = 20;
const JWK_RATE_WINDOW_MS = 1_000;

/** How long a forwarded op may take before its caller is told the instance
 * could not be reached (§7.3).
 *
 * Chosen rather than derived: no primary source states a deadline. The
 * reasoning is that the two outcomes this sits between are both worse than a
 * plain answer — a caller left waiting on an instance that will never reply,
 * and a caller told "unreachable" about an instance that was merely busy — and
 * that the heartbeat already declares a silent link dead well after this, so
 * the deadline is about the op rather than about the link. */
export const FORWARD_TIMEOUT_MS = 10_000;

/** What the instance gives the mesh once it exists.
 *
 * The mesh is built before the instance, because the listener has to be up for
 * self-identification to reach it (§8.3), so the two things a link needs from
 * the instance arrive afterwards rather than through the constructor. */
export interface MeshHost {
  /** The one door a frame goes through (§3.2). A request a peer carried here
   * is answered by the same dispatch every other request is. */
  handle(frame: unknown, conn: Requester): Promise<DispatchResult>;
  /** Hand a relayed frame to this instance's own subscribers (§7.4). */
  publish(topic: string, data: unknown, instance: InstanceId): void;
  /** Which instances can be reached has changed, which is part of what this
   * instance states on `peers` (§7.5). */
  changed(): void;
}

export interface MeshDeps {
  readonly peers: readonly InstanceId[];
  readonly conns: ConnRegistry;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Something changed about which peers are reachable. */
  readonly onChanged?: () => void;
  readonly heartbeatMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly reconnectMinMs?: number;
  readonly forwardTimeoutMs?: number;
  /** The clock the retention window of §7.5 is read against. */
  readonly now?: () => Timestamp;
}

/** One established mesh link. */
interface Link {
  readonly conn: Requester;
  /** One actor per caller this link has spoken for, keyed by the identity
   * itself. Cached rather than made per request because a subscription is held
   * by a connection and released when it closes (§6.3): the topic mechanism
   * has to see the same object each time one caller subscribes. */
  readonly actors: Map<string, PeerActor>;
  /** Which end opened the socket, which is what the glare rule compares (§8.1). */
  readonly dialledByUs: boolean;
  readonly heartbeat: ReturnType<typeof setInterval>;
  lastHeard: number;
}

/** One request this instance forwarded and is waiting on (§7.3). */
interface Forwarded {
  readonly peer: InstanceId;
  /** The id the caller used, restored on the reply so the caller's connection
   * settles the request it actually made. */
  readonly requestId: string;
  readonly settle: (result: DispatchResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One caller a proven peer forwarded here, as the connection its request
 * arrived on.
 *
 * The envelope's `caller` is taken as said. It is the one thing the
 * destination believes on the forwarder's word, and it can, because the link
 * is authenticated: mesh-peer-auth proved the far end is an instance on the
 * peer list, and a peer list is one deployment (§8.2). Everything else is
 * decided here — the role check reads this identity against this instance's
 * own attribute table, and so do the capability and locality checks, which is
 * what §7.3 means by putting a forwarded op through the steps again rather
 * than taking the forwarder's outcome for it.
 *
 * `from_instance` is not part of that judgement: the field says where the
 * reply goes, and the link says who sent it. */
class PeerActor implements Requester {
  constructor(
    private readonly conn: Requester,
    readonly identity: SettledIdentity,
  ) {}

  send(frame: object): void {
    this.conn.send(frame);
  }

  /** Sent rather than queued. Deferring exists so a subscribe's snapshot
   * follows its acknowledgement on the caller's connection; a peer settles its
   * subscription on the reply's `request_id` and folds frames as they arrive,
   * so there is no order here to keep. */
  deferSend(frame: object): void {
    this.conn.send(frame);
  }

  onClose(listener: () => void): void {
    this.conn.onClose(listener);
  }

  close(code?: number, reason?: string): void {
    this.conn.close(code, reason);
  }
}

/** One handshake this instance is verifying, as the receiving end (§5).
 *
 * Everything the verification needs is here and nowhere else, so the whole of
 * what a handshake leaves behind is one map entry that is deleted when it
 * finishes — which is what §10.5 asks be true. */
interface Pending {
  readonly claim: MeshClaim;
  readonly challenge: string;
  readonly deliver: (jws: string) => void;
  readonly fail: (cause: Error) => void;
}

/** One key this instance minted for a connection it dialled (§7). */
interface Minted {
  readonly key: EphemeralKey;
  readonly aud: InstanceId;
  conn?: Requester;
}

/** Which of two connections to one peer survives a glare (§8.1).
 *
 * The connection opened by the smaller `iss` is the one that stays. Neither is
 * better than the other — both were verified before either was dropped — so
 * there is nothing to prefer; what the rule is for is that the two ends reach
 * the same conclusion, which they do because they compare the same two strings.
 *
 * Stated apart from the link it decides about, because that is what makes "both
 * ends agree" a thing that can be checked rather than inferred. */
export function glareKeepsNew(self: InstanceId, peer: InstanceId, dialledByUs: boolean): boolean {
  return dialledByUs ? self < peer : peer < self;
}

/** The mesh: the links to the other instances, and the handshake that decides
 * what each of them is.
 *
 * Every instance dials every peer, so there is no side that owns a link and no
 * peer that cannot be recovered from the other end (§8, and §12's reason for
 * not assigning the duty to one side). */
export class Mesh {
  #self: InstanceId | undefined;
  readonly #links = new Map<InstanceId, Link>();
  readonly #pending = new Map<Requester, Pending>();
  readonly #minted = new Map<string, Minted>();
  readonly #retries = new Map<InstanceId, ReturnType<typeof setTimeout>>();
  readonly #backoff = new Map<InstanceId, number>();
  readonly #identification = new SelfIdentification();
  #jwkWindow = 0;
  #jwkServed = 0;
  #stopping = false;

  readonly #marked = new WeakSet<Requester>();
  /** The link a proven connection belongs to, for the two questions asked per
   * frame: who it may speak for, and whether it may settle a forwarded reply. */
  readonly #linkOf = new Map<Requester, Link>();
  readonly #forwarded = new Map<string, Forwarded>();
  /** The relayed topics local subscribers are asking for right now. `peers` is
   * always among them: it is the routing table of §7.3, and a question about
   * where a session lives is answered whether or not anyone is subscribed
   * (§6.3, "reading the current value is not what subscription drives"). */
  readonly #demanded = new Set<string>(["peers"]);
  #host: MeshHost | undefined;

  /** What the peers said, kept across a disconnection (§7.5). */
  readonly relay: Relay;

  constructor(private readonly deps: MeshDeps) {
    this.relay = new Relay({
      publish: (topic, data, instance) => {
        this.#host?.publish(topic, data, instance);
      },
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  }

  /** Give the mesh the instance it belongs to (§8.3). */
  bind(host: MeshHost): void {
    this.#host = host;
  }

  /** The registry the mesh's own connections are in. It is the instance's, and
   * is shared because a mesh link is one of its connections (§3.1). */
  get conns(): ConnRegistry {
    return this.deps.conns;
  }

  /** Note a connection that was let past the entry token as a peer. */
  accept(conn: Requester, info: { readonly mesh: boolean }): void {
    if (info.mesh) this.#marked.add(conn);
  }

  /** Whether this connection came in as a peer and has not proven what it is.
   *
   * Such a connection presented nothing: it was admitted so that it could make
   * the one claim that can be checked, and until it does it may do that and
   * nothing else. */
  unproven(conn: Requester): boolean {
    return this.#marked.has(conn) && conn.identity.state !== "settled";
  }

  /** The peers this instance dials: the configured list without itself.
   *
   * The list is the same on every instance, which is what lets one file be
   * distributed to all of them (§8.2), so removing ourselves is the reader's
   * job rather than the writer's. */
  get peers(): InstanceId[] {
    return this.deps.peers.filter((peer) => peer !== this.#self);
  }

  get self(): InstanceId | undefined {
    return this.#self;
  }

  /** Whether a link to this peer is established and proven. */
  reachable(peer: InstanceId): boolean {
    return this.#links.has(peer);
  }

  /** What `hello` reports: this instance, then every peer with whether it can
   * be reached right now (§7.5). */
  instances(self: InstanceId): InstanceInfo[] {
    return [
      { id: self, host: hostname(), reachable: true },
      ...this.peers.map((peer) => ({
        id: peer,
        host: new URL(peer).hostname,
        reachable: this.reachable(peer),
      })),
    ];
  }

  /** Whether any peer is currently out of reach.
   *
   * What separates "no instance in the cluster knows this session" from "an
   * instance that might know it cannot be asked" — the one distinction §4.2
   * says rests on the mesh's connection state and on nothing else. */
  anyUnreachable(): boolean {
    return this.peers.some((peer) => !this.reachable(peer));
  }

  /** Which instance should answer for a session this instance does not hold.
   *
   * A session the cluster has named belongs to the instance its `peers` row
   * states. One nobody has named while a peer is out of reach is answered with
   * that peer: forwarding there fails and the caller is told
   * `instance_unreachable`, which is what §4.2 asks for in place of deciding
   * the session does not exist. */
  ownerOf(sid: Sid): InstanceId | undefined {
    const owner = this.relay.owner(sid);
    if (owner !== undefined) return owner;
    return this.peers.find((peer) => !this.reachable(peer));
  }

  // --- op forwarding (§7.3) ---

  /** Carry one op to the instance that owns its subject, and bring the answer
   * back.
   *
   * The request keeps its shape and gains the envelope's three fields. Its
   * `request_id` is reissued because uniqueness has to hold among one
   * connection's in-flight requests (contract, `RequestEnvelope`) and this
   * connection is the link, not the caller's; the caller's id is put back on
   * the reply.
   *
   * `caller` is who the destination will run it as. It is stated by this
   * instance from the connection the request came in on, never carried over
   * from what the request said about itself — a client that wrote a `caller`
   * of its own would otherwise choose the identity it is forwarded as. */
  async forward(
    to: InstanceId,
    frame: Record<string, unknown>,
    caller: CallerIdentity | undefined,
  ): Promise<DispatchResult> {
    const self = this.#self;
    const requestId = frame["request_id"] as string;
    const link = this.#links.get(to);
    if (link === undefined || self === undefined) {
      return failure(requestId, "instance_unreachable", `${to} cannot be reached`);
    }
    const hops = Array.isArray(frame["hops"]) ? (frame["hops"] as InstanceId[]) : [];
    const op = String(frame["op"]);
    const carried = `mesh-fwd-${randomId()}`;
    const settled = Promise.withResolvers<DispatchResult>();
    const timer = setTimeout(() => {
      this.#forwarded.delete(carried);
      settled.resolve(
        failure(requestId, "instance_unreachable", `${to} did not answer ${op} in time`),
      );
    }, this.deps.forwardTimeoutMs ?? FORWARD_TIMEOUT_MS);
    timer.unref?.();
    this.#forwarded.set(carried, {
      peer: to,
      requestId,
      timer,
      settle: settled.resolve,
    });
    link.conn.send({
      ...frame,
      request_id: carried,
      to_instance: to,
      from_instance: self,
      hops: [...hops, self],
      ...(caller === undefined ? {} : { caller }),
    });
    return await settled.promise;
  }

  /** Whether this connection is an established link to a peer. */
  isLink(conn: Requester): boolean {
    return this.#linkOf.has(conn);
  }

  /** The connection a forwarded request is dispatched as (§7.3).
   *
   * The caller the envelope names, on the link it arrived over. A request that
   * names none is dispatched as the link itself, whose role is `instance` —
   * which the attribute table already answers, since no instance-local op is
   * open to an instance. */
  caller(conn: Requester, caller: CallerIdentity | undefined): Requester {
    const link = this.#linkOf.get(conn);
    if (link === undefined || caller === undefined) return conn;
    const key = `${caller.role}/${caller.sid ?? ""}`;
    const held = link.actors.get(key);
    if (held !== undefined) return held;
    const actor = new PeerActor(conn, {
      state: "settled",
      role: caller.role,
      ...(caller.sid === undefined ? {} : { sid: caller.sid }),
    });
    link.actors.set(key, actor);
    return actor;
  }

  // --- event relay (§7.4) ---

  /** The current value of a relayed topic, one entry per instance that has
   * stated one. Handed to a fresh local subscriber beside this instance's own
   * snapshot, so it opens on the cluster rather than on us. */
  snapshot(topic: string): readonly TopicValue[] {
    return this.relay.snapshot(topic);
  }

  /** A local subscriber appeared on a cluster topic, or the last one left.
   *
   * The subscription travels: what a subscriber asks of this instance, this
   * instance asks of every peer, and the frames come back unchanged (§7.4).
   * `peers` is never given up, because it is also the routing table. */
  demand(topic: string, wanted: boolean): void {
    if (!isClusterTopic(topic)) return;
    if (wanted) {
      if (this.#demanded.has(topic)) return;
      this.#demanded.add(topic);
      for (const link of this.#links.values()) this.#ask(link.conn, topic, true);
      return;
    }
    if (topic === "peers" || !this.#demanded.delete(topic)) return;
    for (const link of this.#links.values()) this.#ask(link.conn, topic, false);
  }

  /** Ask a peer for a topic, or give it up.
   *
   * `afterAck` is for the one moment this cannot be sent straight away: on the
   * link we accepted, the handshake is finished by the reply to the greeting,
   * and a peer that hears anything before that reply reads it as speaking out
   * of turn and drops the connection (mesh-peer-auth §5.8). Deferring is what
   * the connection already offers for "once the reply in flight has gone", so
   * the ordering is the connection's rather than a delay chosen here. */
  #ask(conn: Requester, topic: string, wanted: boolean, afterAck = false): void {
    const frame = {
      op: wanted ? "topic_subscribe" : "topic_unsubscribe",
      request_id: `mesh-sub-${randomId()}`,
      topic,
      // The instance asks on behalf of whoever subscribed to it, and what they
      // have in common is that they are this deployment's people rather than
      // any one session: a cluster topic is the same value for all of them
      // (§6.2), so there is nothing narrower to name.
      caller: { role: "user" } satisfies CallerIdentity,
    };
    if (afterAck) conn.deferSend(frame);
    else conn.send(frame);
  }

  /** Settle which of the configured endpoints this instance is (§7.1).
   *
   * Run once the listener is up, because the probe this instance sends to
   * itself has to arrive somewhere. */
  async identify(): Promise<InstanceId> {
    this.#self = await this.#identification.settle(this.deps.peers);
    return this.#self;
  }

  /** Start dialling. Each peer is attempted independently, and a peer that is
   * not there is retried rather than waited for. */
  connect(self: InstanceId): void {
    this.#self ??= self;
    for (const peer of this.peers) void this.#dial(peer);
  }

  // --- the receiving end (mesh-peer-auth §5, steps 4 and 10) ---

  /** Verify a greeting, and answer only if the connection is proven to be the
   * peer it names.
   *
   * The whole judgement is here, inside the op that dispatch already validated
   * and allowed: nothing settles an identity on another path, and a handshake
   * that fails any step throws, which is what leaves the connection anonymous
   * (§3.2 step 7). */
  async greet(conn: Requester, claim: MeshClaim): Promise<void> {
    const self = this.#self;
    if (self === undefined) {
      throw new OpError("capability_unavailable", "this instance has no mesh to join");
    }
    // 1-3 of §5.7, asked before the key is fetched: the cheap comparisons come
    // first because the fetch reaches out to another host.
    if (claim.ver !== MESH_VER) {
      throw new OpError("invalid_args", `this instance speaks mesh handshake ${MESH_VER}`);
    }
    if (!this.deps.peers.includes(claim.iss)) {
      throw new OpError("forbidden", `${claim.iss} is not a peer of this instance`);
    }
    if (claim.aud !== self) {
      throw new OpError("forbidden", `this instance is ${self}, not ${claim.aud}`);
    }
    const challenge = randomId();
    const proof = Promise.withResolvers<string>();
    this.#pending.set(conn, {
      claim,
      challenge,
      deliver: proof.resolve,
      fail: proof.reject,
    });
    // The connection can go before the key has even been fetched, which is what
    // a peer refused for speaking out of turn does to its own handshake. The
    // rejection is claimed here so that it is never one nobody is waiting for;
    // what acts on it is still the await below.
    proof.promise.catch(() => undefined);
    conn.onClose(() => {
      proof.reject(new Error("the connection went before its proof arrived"));
    });
    try {
      // The key comes over a connection of its own, opened to the endpoint the
      // greeting names. Asking for it on this connection would let whoever
      // opened it answer with their own key and pass their own signature (§6).
      const jwk = await this.#fetchKey(claim, challenge);
      const jws = await withTimeout(
        proof.promise,
        PROOF_LIFETIME_MS,
        "no proof arrived before this handshake expired",
      );
      this.#verify(jws, claim, challenge, jwk);
    } catch (cause) {
      throw cause instanceof OpError
        ? cause
        : new OpError(
            "forbidden",
            `this connection was not proven to be ${claim.iss}: ${String(cause)}`,
          );
    } finally {
      // The challenge is spent whatever happened, so there is no record of it
      // anywhere once the handshake ends (§5.5, §10.5).
      this.#pending.delete(conn);
    }
    this.#hold(claim.iss, conn, false);
  }

  /** A frame that is not an op. True when the mesh took it.
   *
   * The proof arrives here because it belongs on the connection being
   * authenticated (§5), which is the one connection the op vocabulary has no
   * name for: mesh carries no ops of its own (contract, `Plane`). */
  frame(conn: Requester, frame: unknown): boolean {
    const mesh = meshFrameOf(frame);
    if (mesh === undefined) return this.#peerFrame(conn, frame);
    if (mesh.mesh === "ping") {
      conn.send({ mesh: "pong" });
      return true;
    }
    if (mesh.mesh === "pong") {
      this.#heard(conn);
      return true;
    }
    const pending = this.#pending.get(conn);
    // A proof with no handshake waiting for it: either none was started, or the
    // challenge it answers has already been spent. Neither is retried (§5.5).
    if (pending === undefined) {
      conn.close();
      return true;
    }
    pending.deliver(mesh.jws);
    return true;
  }

  /** What a proven link wrote that is not a request: a topic frame to relay
   * (§7.4), or the reply to something this instance forwarded (§7.3).
   *
   * Only a link is read this way. A client connection could otherwise guess a
   * forwarded id and settle a request it has nothing to do with, and could
   * push a topic frame this instance would pass on as a peer's. */
  #peerFrame(conn: Requester, frame: unknown): boolean {
    if (!this.#linkOf.has(conn)) return false;
    if (typeof frame !== "object" || frame === null) return false;
    const fields = frame as Record<string, unknown>;

    const requestId = fields["request_id"];
    // A reply, told from a request by `ok`: the two share the correlation id,
    // and a peer forwarding an op to us uses ids of the same shape we use for
    // our own.
    if (typeof requestId === "string" && typeof fields["ok"] === "boolean") {
      const waiting = this.#forwarded.get(requestId);
      if (waiting !== undefined) {
        this.#forwarded.delete(requestId);
        clearTimeout(waiting.timer);
        waiting.settle(answerOf(fields, waiting.requestId));
        return true;
      }
      // The peer's answer to a subscription this instance asked for. It
      // acknowledges and says nothing further; the value arrives as frames.
      if (requestId.startsWith("mesh-sub-")) return true;
    }

    if (fields["ev"] !== "topic") return false;
    const topic = fields["topic"];
    const instance = fields["instance"];
    if (typeof topic !== "string" || typeof instance !== "string") return true;
    // Our own value, come back around a triangle. Relaying it again would put
    // this instance's value on the wire as something it received.
    if (instance === this.#self) return true;
    this.relay.accept(instance as InstanceId, topic, fields["data"]);
    return true;
  }

  /** Whether this connection is mid-handshake, which is what makes an ordinary
   * request on it a protocol violation rather than an early call (§5.8). */
  handshaking(conn: Requester): boolean {
    return this.#pending.has(conn);
  }

  // --- the HTTP surface: the key of §6 and the probe of self-identification ---

  /** Answer the two requests that are served before anything is proven, or
   * nothing when the request is not one of them. */
  async route(request: Request): Promise<Response | undefined> {
    const pathname = new URL(request.url).pathname;
    const bases = this.#self === undefined ? this.deps.peers : [this.#self];
    for (const base of bases) {
      if (isProbePath(pathname, base)) return await this.#probe(request);
      const kid = kidOfPath(pathname, base);
      if (kid !== undefined) return await this.#serveKey(kid, request);
    }
    return undefined;
  }

  async #probe(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("a probe is a JSON object", { status: 400 });
    }
    const probe = body as Partial<ProbeBody>;
    // An unknown generation is ignored rather than refused: the comparison is
    // the sender's, so a receiver that cannot read the probe costs the sender
    // nothing it could not already have (§5.1).
    if (probe.ver === MESH_VER && typeof probe.token === "string") {
      this.#identification.accept(probe.token);
    }
    return Response.json({});
  }

  async #serveKey(kid: string, request: Request): Promise<Response> {
    if (!this.#allowKeyRequest()) {
      return new Response("too many key requests", { status: 429 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("a key request carries its challenge", { status: 400 });
    }
    const asked = body as Partial<JwkRequest>;
    if (asked.ver !== MESH_VER || typeof asked.challenge !== "string" || asked.challenge === "") {
      return new Response("a key request carries a generation and a challenge", { status: 400 });
    }
    const minted = this.#minted.get(kid);
    // Unknown to us, or known and no longer connected to the handshake it was
    // made for. Either way there is no key to give (§6.1).
    if (minted === undefined || minted.conn === undefined) {
      return new Response("no such key", { status: 404 });
    }
    // The proof goes back on the connection being authenticated, not on this
    // one. The two meet at the `kid`.
    const claim = {
      ver: MESH_VER,
      iss: this.#self as InstanceId,
      aud: minted.aud,
      challenge: asked.challenge,
      exp: Math.floor((Date.now() + PROOF_LIFETIME_MS) / 1000),
    };
    minted.conn.send({ mesh: "proof", jws: minted.key.proof(claim) });
    const answer: JwkResponse["jwk"] = minted.key.jwk();
    return new Response(JSON.stringify(answer), {
      headers: { "content-type": "application/jwk+json" },
    });
  }

  /** A fixed window rather than a queue: what this protects against is a caller
   * making this instance sign and serve in a loop, and a count per second says
   * that plainly. */
  #allowKeyRequest(): boolean {
    const now = Date.now();
    if (now - this.#jwkWindow >= JWK_RATE_WINDOW_MS) {
      this.#jwkWindow = now;
      this.#jwkServed = 0;
    }
    this.#jwkServed += 1;
    return this.#jwkServed <= JWK_RATE_LIMIT;
  }

  // --- the dialling end (§5, steps 1-3 and 13) ---

  async #dial(peer: InstanceId): Promise<void> {
    if (this.#stopping || this.#links.has(peer)) return;
    const self = this.#self;
    if (self === undefined) return;
    const key = new EphemeralKey();
    const minted: Minted = { key, aud: peer };
    this.#minted.set(key.kid, minted);
    let conn: Conn;
    try {
      conn = await dialWs({
        url: wsEndpoint(peer),
        protocols: [MESH_PROTOCOL],
        conns: this.deps.conns,
        onFrame: (frame, on) => {
          this.#dialledFrame(peer, on, frame, key.kid);
        },
        onClose: (code) => {
          this.#minted.delete(key.kid);
          this.#drop(peer, conn);
          // The loser of a glare is closed on purpose by the other end, and
          // redialling it would reopen what both sides just agreed to drop.
          if (code !== GLARE_CLOSE) this.#retry(peer);
        },
      });
    } catch {
      this.#minted.delete(key.kid);
      this.#retry(peer);
      return;
    }
    minted.conn = conn;
    conn.send({
      op: "hello",
      request_id: `mesh-hello-${key.kid}`,
      role: "instance",
      protocol_version: PROTOCOL_VERSION,
      mesh: { ver: MESH_VER, iss: self, aud: peer, kid: key.kid },
    });
  }

  /** What the far end wrote on a connection we opened.
   *
   * The greeting's reply is the acknowledgement of §5.8: it is what says the
   * peer finished verifying, which is both the moment this instance may speak
   * and the moment its key has no further use. */
  #dialledFrame(peer: InstanceId, conn: Requester, frame: unknown, kid: string): void {
    if (this.frame(conn, frame)) return;
    const fields = frame as Record<string, unknown>;
    if (fields["request_id"] !== `mesh-hello-${kid}`) {
      // A request the peer forwarded to us. A dialled connection is answered by
      // whoever dialled it (transport, `DialOptions`), so the reply goes out
      // here rather than through the driver — but what decides it is the same
      // dispatch every other request goes through (§7.3).
      if (typeof fields["op"] === "string") this.#answer(conn, fields);
      return;
    }
    this.#minted.delete(kid);
    if (fields["ok"] !== true) {
      const error = fields["error"] as { msg?: string } | undefined;
      this.deps.log?.("mesh peer refused this instance", { peer, msg: error?.msg });
      conn.close();
      return;
    }
    this.#hold(peer, conn, true);
  }

  /** Run one request a peer wrote on a connection we dialled, and write the
   * answer back on it. */
  #answer(conn: Requester, fields: Record<string, unknown>): void {
    void this.#host?.handle(fields, conn).then(
      (result) => {
        if (result.kind === "none") return;
        conn.send(
          result.kind === "forward"
            ? failure(
                fields["request_id"] as string,
                "instance_unreachable",
                `${result.to} cannot be reached`,
              ).response
            : result.response,
        );
      },
      (cause: unknown) => {
        conn.send(
          failure(
            fields["request_id"] as string,
            "internal_error",
            `the forwarded request could not be answered: ${String(cause)}`,
          ).response,
        );
      },
    );
  }

  // --- links, glare and the heartbeat ---

  /** Take a proven connection as the link to this peer, resolving a glare if
   * one is already held.
   *
   * Both connections are verified before either is dropped, so whichever
   * survives is one that was proven (§8.1). */
  #hold(peer: InstanceId, conn: Requester, dialledByUs: boolean): void {
    const self = this.#self as InstanceId;
    const held = this.#links.get(peer);
    if (held !== undefined) {
      if (held.conn === conn) return;
      const keepNew = glareKeepsNew(self, peer, dialledByUs);
      if (!keepNew) {
        conn.close(GLARE_CLOSE, "glare");
        return;
      }
      clearInterval(held.heartbeat);
      this.#links.delete(peer);
      this.#linkOf.delete(held.conn);
      held.conn.close(GLARE_CLOSE, "glare");
    }
    const heartbeat = setInterval(() => {
      this.#beat(peer);
    }, this.deps.heartbeatMs ?? HEARTBEAT_MS);
    heartbeat.unref?.();
    const link: Link = {
      conn,
      actors: new Map<string, PeerActor>(),
      dialledByUs,
      heartbeat,
      lastHeard: Date.now(),
    };
    this.#linkOf.set(conn, link);
    this.#links.set(peer, link);
    this.#backoff.delete(peer);
    conn.onClose(() => {
      this.#drop(peer, conn);
    });
    // What it said before is still held and stops being marked; what it says
    // now replaces it, which is the whole of "restored by reconnection" (§7.5).
    this.relay.restored(peer);
    for (const topic of this.#demanded) this.#ask(conn, topic, true, !dialledByUs);
    this.deps.log?.("mesh peer established", { peer, dialled_by_us: dialledByUs });
    this.#changed();
  }

  /** Say that the set of reachable instances moved. Two listeners: whatever
   * the deps gave, and the instance, which restates `peers` — the topic the
   * view rides on (§7.5). */
  #changed(): void {
    this.deps.onChanged?.();
    this.#host?.changed();
  }

  #beat(peer: InstanceId): void {
    const link = this.#links.get(peer);
    if (link === undefined) return;
    const silence = Date.now() - link.lastHeard;
    if (silence > (this.deps.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS)) {
      // Nothing has come back for long enough that the link is gone whatever
      // the socket believes — which is the whole reason for the heartbeat
      // (§8.3): a middlebox drops a connection without telling either end.
      this.deps.log?.("mesh peer went silent", { peer, silence_ms: silence });
      link.conn.close();
      this.#drop(peer, link.conn);
      return;
    }
    link.conn.send({ mesh: "ping" });
  }

  #heard(conn: Requester): void {
    for (const link of this.#links.values()) {
      if (link.conn === conn) link.lastHeard = Date.now();
    }
  }

  #drop(peer: InstanceId, conn: Requester): void {
    const link = this.#links.get(peer);
    if (link === undefined || link.conn !== conn) return;
    clearInterval(link.heartbeat);
    this.#links.delete(peer);
    this.#linkOf.delete(conn);
    // Its sessions become a kind of Disappeared and its values are marked
    // rather than dropped (§7.5), and anything on its way there is answered
    // now instead of waiting out a deadline it can no longer beat.
    this.relay.lost(peer);
    this.#abandon(peer);
    this.deps.log?.("mesh peer lost", { peer });
    this.#changed();
    if (link.dialledByUs) this.#retry(peer);
  }

  /** Answer everything that was waiting on a peer that has gone. */
  #abandon(peer: InstanceId): void {
    for (const [carried, waiting] of this.#forwarded) {
      if (waiting.peer !== peer) continue;
      this.#forwarded.delete(carried);
      clearTimeout(waiting.timer);
      waiting.settle(
        failure(waiting.requestId, "instance_unreachable", `${peer} cannot be reached`),
      );
    }
  }

  /** Try again, later each time up to the ceiling. */
  #retry(peer: InstanceId): void {
    if (this.#stopping || this.#retries.has(peer)) return;
    const min = this.deps.reconnectMinMs ?? RECONNECT_MIN_MS;
    const previous = this.#backoff.get(peer) ?? 0;
    const wait = previous === 0 ? min : Math.min(previous * 2, RECONNECT_MAX_MS);
    this.#backoff.set(peer, wait);
    const timer = setTimeout(() => {
      this.#retries.delete(peer);
      void this.#dial(peer);
    }, wait);
    timer.unref?.();
    this.#retries.set(peer, timer);
  }

  /** Let every link and every timer go. Called from the stop order (§8.5). */
  stop(): void {
    this.#stopping = true;
    for (const timer of this.#retries.values()) clearTimeout(timer);
    this.#retries.clear();
    // The timers go, and so do the sockets this instance opened — but not the
    // ones it accepted.
    //
    // An accepted socket belongs to transport, which releases every one of
    // them after the connections have been told (§8.5 steps 3 and 5): closing
    // one here would take it away before the notice, and measured against Bun
    // 1.3.13 a socket closed from the server side also keeps the listener from
    // ever being given up.
    //
    // A dialled one has no listener behind it, so nothing else will ever
    // release it, and the far end has no other way to learn this instance is
    // going: it would keep the link, keep answering `reachable`, and keep
    // routing `instance-local` ops here until its own heartbeat gave up
    // minutes later — where the disconnection of §7.5 is supposed to be
    // immediate. Which of the two a link is comes from the glare rule and so
    // from a comparison of endpoint strings (§8.1), which means every peer is
    // on the dialled side of some link: leaving these open makes a clean stop
    // look like a silent one to half the cluster.
    for (const link of this.#links.values()) {
      clearInterval(link.heartbeat);
      if (link.dialledByUs) link.conn.close();
    }
    for (const peer of this.#links.keys()) this.#abandon(peer);
    this.#links.clear();
    this.#linkOf.clear();
    // Keys die with the connections they were made for, and none outlives this
    // (§7).
    this.#minted.clear();
    for (const pending of this.#pending.values()) {
      pending.fail(new Error("this instance is stopping"));
    }
    this.#pending.clear();
  }

  /** What is held per handshake right now, so a test can state that nothing is
   * kept once one has finished (§10.5). */
  get held(): { keys: number; handshakes: number; links: number } {
    return {
      keys: this.#minted.size,
      handshakes: this.#pending.size,
      links: this.#links.size,
    };
  }

  // --- verification ---

  async #fetchKey(claim: MeshClaim, challenge: string): Promise<MeshJwk> {
    const body: JwkRequest = { ver: MESH_VER, challenge };
    const response = await fetch(jwkEndpoint(claim.iss, claim.kid), {
      method: "POST",
      // One request and close, which is what the second connection is
      // (§6.2): it exists to carry the key and the challenge, and keeping it
      // pooled afterwards would leave a connection nothing speaks on.
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROOF_LIFETIME_MS),
    });
    if (!response.ok) throw new Error(`${claim.iss} did not hand out the key ${claim.kid}`);
    const jwk = (await response.json()) as MeshJwk;
    // §5.7-8, the third of the three ids that have to agree: a key served under
    // one id and answering to another would break the correspondence the whole
    // exchange is keyed on.
    if (jwk.kid !== claim.kid) throw new Error("the key served is not the key asked for");
    return jwk;
  }

  /** §5.7, steps 4 to 8. */
  #verify(jws: string, claim: MeshClaim, challenge: string, jwk: MeshJwk): void {
    let parsed;
    try {
      parsed = parseProof(jws);
    } catch (cause) {
      throw cause instanceof ProofError ? cause : new Error(String(cause));
    }
    if (!ALLOWED_ALGS.has(parsed.alg)) throw new Error(`${parsed.alg} is not an allowed algorithm`);
    if (parsed.kid !== claim.kid) throw new Error("the proof names another key than the greeting");
    const stated = parsed.claim;
    if (stated.ver !== claim.ver || stated.iss !== claim.iss || stated.aud !== claim.aud) {
      throw new Error("the proof states something other than the greeting did");
    }
    if (stated.challenge !== challenge) throw new Error("the proof answers another challenge");
    if (typeof stated.exp !== "number" || stated.exp * 1000 <= Date.now()) {
      throw new Error("the proof has expired");
    }
    if (!verifyProof(jws, jwk)) throw new Error("the signature is not the key's");
  }
}

/** A peer's reply, as the answer to the request the caller made.
 *
 * The body is passed through untouched — the destination decided it, and this
 * instance re-deciding any of it would put the same judgement in two places.
 * Only the correlation id changes, back to the one the caller used. */
function answerOf(fields: Record<string, unknown>, requestId: string): DispatchResult {
  const { ok: _ok, request_id: _id, ...body } = fields;
  if (fields["ok"] === true) return reply(requestId, body);
  const error = fields["error"] as { code?: string; msg?: string } | undefined;
  return failure(
    requestId,
    (error?.code ?? "internal_error") as Parameters<typeof failure>[1],
    error?.msg ?? "the instance that answered said nothing about why",
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(msg));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}
