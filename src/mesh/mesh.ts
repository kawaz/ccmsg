import { hostname } from "node:os";
import { type InstanceId, type InstanceInfo, PROTOCOL_VERSION } from "@ccmsg/protocol";
import { type Conn, type ConnRegistry, dialWs } from "../transport/index.ts";
import { OpError, type Requester } from "../dispatch/index.ts";
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

export interface MeshDeps {
  readonly peers: readonly InstanceId[];
  readonly conns: ConnRegistry;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Something changed about which peers are reachable. */
  readonly onChanged?: () => void;
  readonly heartbeatMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly reconnectMinMs?: number;
}

/** One established mesh link. */
interface Link {
  readonly conn: Requester;
  /** Which end opened the socket, which is what the glare rule compares (§8.1). */
  readonly dialledByUs: boolean;
  readonly heartbeat: ReturnType<typeof setInterval>;
  lastHeard: number;
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

  constructor(private readonly deps: MeshDeps) {}

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
    if (mesh === undefined) return false;
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
    if (fields["request_id"] !== `mesh-hello-${kid}`) return;
    this.#minted.delete(kid);
    if (fields["ok"] !== true) {
      const error = fields["error"] as { msg?: string } | undefined;
      this.deps.log?.("mesh peer refused this instance", { peer, msg: error?.msg });
      conn.close();
      return;
    }
    this.#hold(peer, conn, true);
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
      held.conn.close(GLARE_CLOSE, "glare");
    }
    const heartbeat = setInterval(() => {
      this.#beat(peer);
    }, this.deps.heartbeatMs ?? HEARTBEAT_MS);
    heartbeat.unref?.();
    this.#links.set(peer, { conn, dialledByUs, heartbeat, lastHeard: Date.now() });
    this.#backoff.delete(peer);
    conn.onClose(() => {
      this.#drop(peer, conn);
    });
    this.deps.log?.("mesh peer established", { peer, dialled_by_us: dialledByUs });
    this.deps.onChanged?.();
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
    this.deps.log?.("mesh peer lost", { peer });
    this.deps.onChanged?.();
    if (link.dialledByUs) this.#retry(peer);
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
    // The timers go; the sockets do not. A connection belongs to transport,
    // which releases every one of them after the connections have been told
    // (§8.5 steps 3 and 5) — closing them here would take them away before the
    // notice, and measured against Bun 1.3.13 a socket closed from the server
    // side also keeps the listener from ever being given up.
    for (const link of this.#links.values()) clearInterval(link.heartbeat);
    this.#links.clear();
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
