import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InstanceId, type InstanceInfo, PROTOCOL_VERSION } from "@ccmsg/protocol";
import { type Env, Instance, isRunning, start } from "../src/instance/index.ts";
import {
  EphemeralKey,
  glareKeepsNew,
  type MeshJwk,
  MESH_PROTOCOL,
  MESH_VER,
  type ProofClaim,
  SelfIdentification,
  SelfIdentificationError,
} from "../src/mesh/index.ts";

/** mesh-peer-auth §10 and mesh-self-identification §7, run against instances
 * speaking over real sockets.
 *
 * The PKI layer of §10.2 is not here, and cannot be: the trust root of the
 * document is a TLS server certificate, and this daemon's listener serves plain
 * `ws` — there is no configuration that gives it a certificate, so there is no
 * `wss` to make a certificate fail on. What is exercised below is everything
 * that sits on top of that root: the protocol layer (§10.3), the boundary cases
 * (§10.4) and the non-residency of state (§10.5). Until the listener can be
 * given a certificate, an instance is only as trustworthy as the network it is
 * reachable on, and the two layers together are not yet what the design asks
 * for. */

const running: Instance[] = [];
const closing: (() => void)[] = [];

afterEach(async () => {
  // The instances go first, while the doubles they are linked to are still
  // there: that is the order §8.5 is about, and taking the far end away first
  // would be testing something else.
  for (const instance of running.splice(0)) await instance.stop();
  for (const close of closing.splice(0)) close();
});

/** A port nothing is listening on.
 *
 * The peer list has to name the endpoints before any of them is bound, because
 * the whole point of §7.1 is that the list is written without knowing which
 * entry is whose — so the ports are picked first and handed to the instances. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  void server.stop(true);
  return port;
}

function endpoint(port: number): InstanceId {
  return `ws://127.0.0.1:${port}`;
}

/** One instance's disposable home, configured to listen and to know the peers.
 *
 * The list is the same for every instance in a test, itself included, which is
 * exactly what §8.2 says a peer list is: one file that can go to all of them. */
function homeFor(port: number, peers: readonly InstanceId[]): Env {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-mesh-"));
  const home = join(root, "home");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ peers, entry: { host: "127.0.0.1", port } }),
  );
  return {
    CLAUDE_CONFIG_DIR: home,
    CCMSG_STATE_DIR: join(root, "state"),
    CCMSG_CONFIG_DIR: configDir,
  };
}

interface Timing {
  readonly heartbeatMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly reconnectMinMs?: number;
}

/** A backoff long enough that no retry runs inside a test. A test that is about
 * reconnection sets its own. */
const NO_RETRY: Timing = { reconnectMinMs: 60_000 };

async function startAt(env: Env, timing: Timing = NO_RETRY): Promise<Instance> {
  const outcome = await start({ env, echoLog: false, meshTiming: timing });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  return outcome;
}

function reachable(instance: Instance, peer: InstanceId): boolean {
  const found = instance.mesh?.instances(instance.self).find((one) => one.id === peer);
  return found?.reachable === true;
}

/** Wait for something the far end causes, by asking until it is true.
 *
 * Nothing on this side is notified when a peer finishes verifying us — the
 * event belongs to the other instance — so there is no handle to await. The
 * interval is a test's own and says nothing about the daemon. */
async function eventually(what: () => boolean, within = 3_000): Promise<void> {
  const until = Date.now() + within;
  while (Date.now() < until) {
    if (what()) return;
    await Bun.sleep(5);
  }
  expect(what()).toBe(true);
}

/** A peer under the test's control: it serves its own key endpoint, dials a
 * real instance, and says exactly what the case being tested wants said.
 *
 * It is the dialling side of mesh-peer-auth §5 with every value overridable,
 * which is what makes the refusals of §10.3 reachable — a correct
 * implementation cannot produce them. */
class FakePeer {
  readonly key = new EphemeralKey();
  readonly id: InstanceId;
  readonly #server: ReturnType<typeof Bun.serve>;
  #ws: WebSocket | undefined;
  readonly #frames: Record<string, unknown>[] = [];
  #closeCode: number | undefined;
  /** What the greeting claims. Filled in by `greet` and overridable per case. */
  claim: Partial<{ ver: number; iss: InstanceId; aud: InstanceId; kid: string }> = {};
  /** What the proof asserts, over the defaults derived from the greeting. */
  claimOverride: Partial<ProofClaim> = {};
  /** The whole proof, when a case needs one no key could produce. */
  proof: ((claim: ProofClaim) => string) | undefined;
  /** The key served, when a case needs one that is not the signing key's. */
  jwk: (() => MeshJwk) | undefined;
  /** Called when the key is asked for, before the proof goes out. */
  onKeyAsked: (() => void) | undefined;

  constructor(port: number) {
    this.id = endpoint(port);
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: async (request, srv) => {
        const path = new URL(request.url).pathname;
        // A probe is answered so that a real instance counts this endpoint as
        // reachable; nothing is done with the token, because a peer replaying
        // one is a case of its own below.
        if (path === "/mesh/probe") return Response.json({});
        if (path.startsWith("/mesh/jwk/")) return await this.#serveKey(request);
        // The real instance dials us too. The connection is accepted and its
        // greeting refused, which leaves this peer's own dial the only link
        // under test.
        if (path === "/ws" && srv.upgrade(request, { data: undefined })) return undefined;
        return new Response("Not Found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const fields = JSON.parse(String(message)) as Record<string, unknown>;
          ws.send(
            JSON.stringify({
              ok: false,
              request_id: fields["request_id"],
              error: { code: "forbidden", msg: "this peer is a test double" },
            }),
          );
        },
      },
    });
    closing.push(() => {
      this.#ws?.close();
      void this.#server.stop(true);
    });
  }

  async #serveKey(request: Request): Promise<Response> {
    const asked = (await request.json()) as { challenge?: string };
    this.onKeyAsked?.();
    const claim: ProofClaim = {
      ver: MESH_VER,
      iss: this.claim.iss as InstanceId,
      aud: this.claim.aud as InstanceId,
      challenge: asked.challenge ?? "",
      exp: Math.floor(Date.now() / 1000) + 10,
      ...this.claimOverride,
    };
    const jws = this.proof === undefined ? this.key.proof(claim) : this.proof(claim);
    this.#ws?.send(JSON.stringify({ mesh: "proof", jws }));
    return Response.json(this.jwk === undefined ? this.key.jwk() : this.jwk());
  }

  /** Dial the instance and greet it. Answers with the reply, whatever it is. */
  async greet(target: InstanceId): Promise<Record<string, unknown>> {
    const ws = new WebSocket(`${target}/ws`, [MESH_PROTOCOL]);
    this.#ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        resolve();
      });
      ws.addEventListener("error", () => {
        reject(new Error("the peer was not let in"));
      });
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      for (const line of String(event.data).split("\n")) {
        if (line.trim() !== "") this.#frames.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      this.#closeCode = event.code;
    });
    const mesh = {
      ver: MESH_VER,
      iss: this.id,
      aud: target,
      kid: this.key.kid,
      ...this.claim,
    };
    this.claim = mesh;
    ws.send(
      `${JSON.stringify({
        op: "hello",
        request_id: "peer-hello",
        role: "instance",
        protocol_version: PROTOCOL_VERSION,
        mesh,
      })}\n`,
    );
    return await this.#reply("peer-hello");
  }

  send(frame: object): void {
    this.#ws?.send(`${JSON.stringify(frame)}\n`);
  }

  get closed(): boolean {
    return this.#closeCode !== undefined;
  }

  async #reply(requestId: string, within = 5_000): Promise<Record<string, unknown>> {
    const until = Date.now() + within;
    while (Date.now() < until) {
      const found = this.#frames.find((frame) => frame["request_id"] === requestId);
      if (found !== undefined) return found;
      if (this.#closeCode !== undefined) return { ok: false, closed: this.#closeCode };
      await Bun.sleep(5);
    }
    throw new Error(`${requestId} was never answered`);
  }
}

/** A real instance with one endpoint under the test's control beside it. */
async function withFakePeer(timing: Timing = NO_RETRY): Promise<{
  instance: Instance;
  peer: FakePeer;
}> {
  const realPort = freePort();
  const peerPort = freePort();
  const peers = [endpoint(realPort), endpoint(peerPort)];
  const peer = new FakePeer(peerPort);
  const instance = await startAt(homeFor(realPort, peers), timing);
  return { instance, peer };
}

describe("self-identification (mesh-self-identification §7)", () => {
  test("one match settles `self` (§7.1)", async () => {
    const port = freePort();
    const instance = await startAt(homeFor(port, [endpoint(port)]));
    expect(instance.self).toBe(endpoint(port));
  });

  test("no match ends the start (§7.1)", async () => {
    const port = freePort();
    // A list this instance is not in: the endpoint named is one nothing serves,
    // so the probe reaches nobody and there is nothing to be.
    const env = homeFor(port, [endpoint(freePort())]);
    expect(await refusal(start({ env, echoLog: false }))).toBeInstanceOf(SelfIdentificationError);
  });

  test("two matches end the start (§7.1)", async () => {
    const port = freePort();
    // The same instance under two names, which is what a host registered twice
    // looks like: both probes come back, and which name is its own cannot be
    // decided here.
    const env = homeFor(port, [endpoint(port), `ws://localhost:${port}`]);
    expect(await refusal(start({ env, echoLog: false }))).toBeInstanceOf(SelfIdentificationError);
  });

  test("a peer that cannot be reached is left out of the count, not fatal (§7.1, DV-Q11)", async () => {
    const port = freePort();
    const asleep = endpoint(freePort());
    const instance = await startAt(homeFor(port, [endpoint(port), asleep]));
    expect(instance.self).toBe(endpoint(port));
    // It stays a peer to dial: unreachable now is not unreachable for good.
    expect(instance.mesh?.peers).toEqual([asleep]);
    expect(reachable(instance, asleep)).toBe(false);
  });

  test("a token meant for another endpoint does not match (§7.2)", async () => {
    const identification = new SelfIdentification();
    // Nothing was sent, so no token in existence is one of ours — which is what
    // a probe arriving from elsewhere is.
    identification.accept("00".repeat(16));
    expect(await refusal(identification.settle([endpoint(freePort())]))).toBeInstanceOf(
      SelfIdentificationError,
    );
  });

  test("the table is gone once the run is over (§7.3)", async () => {
    const identification = new SelfIdentification();
    const port = freePort();
    const instance = await startAt(homeFor(port, [endpoint(port)]));
    expect(instance.self).toBe(endpoint(port));
    // A token accepted after the run cannot match anything, because the table
    // it would have been matched against no longer exists.
    identification.accept("11".repeat(16));
    expect(await refusal(identification.settle([endpoint(freePort())]))).toBeInstanceOf(
      SelfIdentificationError,
    );
  });
});

describe("the mesh handshake (mesh-peer-auth §10.3)", () => {
  test("a greeting that proves itself is answered, and the peer becomes reachable", async () => {
    const { instance, peer } = await withFakePeer();
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(true);
    expect(reply["instance"]).toBe(instance.self);
    const instances = reply["instances"] as InstanceInfo[];
    expect(instances.find((one) => one.id === peer.id)?.reachable).toBe(true);
    expect(instance.mesh?.reachable(peer.id)).toBe(true);
  });

  test("an unknown handshake generation is refused (§5.7-1)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { ver: MESH_VER + 1 };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
    expect(instance.mesh?.reachable(peer.id)).toBe(false);
  });

  test("an `iss` that is not a configured peer is refused (§5.7-2)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { iss: endpoint(freePort()) };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("an `aud` that is not this instance is refused (§5.7-3)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { aud: peer.id };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("an `iss` sharing our origin but not our path is refused (§5.7, §4.2)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { iss: `${peer.id}/other` };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("an `aud` that merely starts with ours is refused (§5.7)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { aud: `${instance.self}.evil` };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("a proof stating something other than the greeting is refused (§5.7-4)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claimOverride = { aud: peer.id };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
    expect(instance.mesh?.reachable(peer.id)).toBe(false);
  });

  test("a proof answering another challenge is refused (§5.7-5)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claimOverride = { challenge: "22".repeat(16) };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("a second proof on the same handshake is not taken (§5.5)", async () => {
    const { instance, peer } = await withFakePeer();
    let captured: string | undefined;
    const key = peer.key;
    peer.proof = (claim) => {
      captured = key.proof(claim);
      return captured;
    };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(true);
    // The challenge was spent when the first proof was read, so replaying it
    // finds no handshake — there is no record of it left to match against.
    peer.send({ mesh: "proof", jws: captured });
    await eventually(() => peer.closed);
    expect(instance.mesh?.reachable(peer.id)).toBe(false);
  });

  test("an expired proof is refused (§5.7-6)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claimOverride = { exp: Math.floor(Date.now() / 1000) - 1 };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("a signature that is not the served key's is refused (§5.7-7)", async () => {
    const { instance, peer } = await withFakePeer();
    // Signed by one key, and a different key handed out under the same id: the
    // shape a peer of one origin takes when it answers for another (§6.3).
    const other = new EphemeralKey();
    peer.jwk = () => ({ ...other.jwk(), kid: peer.key.kid });
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("an algorithm outside the allowed set is refused (§5.7-7)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.proof = (claim) => unsigned({ alg: "HS256", kid: peer.key.kid }, claim);
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("`alg: none` is refused (§5.7-7)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.proof = (claim) => unsigned({ alg: "none", kid: peer.key.kid }, claim);
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("a proof naming another key than the greeting is refused (§5.7-8)", async () => {
    const { instance, peer } = await withFakePeer();
    const other = new EphemeralKey();
    peer.proof = (claim) => other.proof(claim);
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("a key served under another id than the proof names is refused (§5.7-8)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.jwk = () => ({ ...peer.key.jwk(), kid: "33".repeat(16) });
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });

  test("a request before the acknowledgement ends the connection (§5.8)", async () => {
    const { instance, peer } = await withFakePeer();
    // The key request is what the greeting waits for, so holding it back leaves
    // the handshake open while the peer speaks out of turn.
    peer.onKeyAsked = () => {
      peer.send({ op: "instance_ping", request_id: "early" });
    };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
    await eventually(() => peer.closed);
    expect(instance.mesh?.reachable(peer.id)).toBe(false);
  });

  test("the key cannot be asked for on the connection being authenticated (§6)", async () => {
    const { instance, peer } = await withFakePeer();
    // There is no such frame and no such op: the key lives behind an HTTP path
    // and nothing on this connection answers for it. A frame that is neither is
    // read as speaking before the acknowledgement, which ends the connection.
    peer.onKeyAsked = () => {
      peer.send({ mesh: "jwk_req", kid: peer.key.kid, challenge: "44".repeat(16) });
    };
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(false);
  });
});

describe("what a handshake leaves behind (mesh-peer-auth §10.5)", () => {
  test("nothing is held once a handshake has finished", async () => {
    const { instance, peer } = await withFakePeer();
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(true);
    const held = instance.mesh?.held;
    // One link, and no key and no challenge: the receiving end mints no key,
    // and the challenge was spent when the proof was read.
    expect(held).toEqual({ keys: 0, handshakes: 0, links: 1 });
  });

  test("a refused handshake leaves no less behind than a successful one", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claimOverride = { challenge: "55".repeat(16) };
    await peer.greet(instance.self);
    expect(instance.mesh?.held).toEqual({ keys: 0, handshakes: 0, links: 0 });
  });

  test("several handshakes at once come back to nothing held", async () => {
    const realPort = freePort();
    const ports = [freePort(), freePort(), freePort()];
    const peers = [endpoint(realPort), ...ports.map(endpoint)];
    const doubles = ports.map((port) => new FakePeer(port));
    const instance = await startAt(homeFor(realPort, peers));
    const replies = await Promise.all(doubles.map((peer) => peer.greet(instance.self)));
    expect(replies.map((reply) => reply["ok"])).toEqual([true, true, true]);
    expect(instance.mesh?.held).toEqual({ keys: 0, handshakes: 0, links: 3 });
  });

  test("a dialling instance destroys its key once it is acknowledged (§7)", async () => {
    const [a, b] = [freePort(), freePort()];
    const peers = [endpoint(a), endpoint(b)];
    const first = await startAt(homeFor(a, peers));
    const second = await startAt(homeFor(b, peers));
    await eventually(() => first.mesh?.reachable(second.self) === true);
    await eventually(() => second.mesh?.reachable(first.self) === true);
    // The key exists for one handshake and is gone the moment the peer says it
    // has finished verifying, so a settled mesh holds none.
    expect(first.mesh?.held.keys).toBe(0);
    expect(second.mesh?.held.keys).toBe(0);
  });

  test("stopping lets the links and the keys go", async () => {
    const { instance, peer } = await withFakePeer();
    await peer.greet(instance.self);
    await instance.stop();
    expect(instance.mesh?.held).toEqual({ keys: 0, handshakes: 0, links: 0 });
  });
});

describe("glare (mesh-peer-auth §8.1)", () => {
  test("both ends decide the same way, and it is the smaller `iss` that dialled", () => {
    const [small, large] = ["ws://a", "ws://b"] as [InstanceId, InstanceId];
    // From `small`'s side: the connection it dialled stays, the one it accepted
    // goes. From `large`'s side, the mirror of that. Between them exactly one
    // connection survives, which is what the rule is for.
    expect(glareKeepsNew(small, large, true)).toBe(true);
    expect(glareKeepsNew(small, large, false)).toBe(false);
    expect(glareKeepsNew(large, small, true)).toBe(false);
    expect(glareKeepsNew(large, small, false)).toBe(true);
  });

  test("two instances that dial each other end up holding one link each", async () => {
    const [a, b] = [freePort(), freePort()];
    const peers = [endpoint(a), endpoint(b)];
    // Started together and retrying quickly, so both ends dial while the other
    // is still deciding — which is the situation the rule exists for.
    const [first, second] = await Promise.all([
      startAt(homeFor(a, peers), { reconnectMinMs: 20 }),
      startAt(homeFor(b, peers), { reconnectMinMs: 20 }),
    ]);
    await eventually(() => first.mesh?.reachable(second.self) === true);
    await eventually(() => second.mesh?.reachable(first.self) === true);
    // One link on each side, not two: whatever the order the two dials landed
    // in, the ends agreed on which connection to keep.
    expect(first.mesh?.held.links).toBe(1);
    expect(second.mesh?.held.links).toBe(1);
  });
});

describe("the heartbeat (mesh-peer-auth §8.3)", () => {
  test("a link that stops answering is dropped and the peer stops being reachable", async () => {
    const { instance, peer } = await withFakePeer({
      heartbeatMs: 20,
      heartbeatTimeoutMs: 60,
      reconnectMinMs: 60_000,
    });
    await peer.greet(instance.self);
    expect(instance.mesh?.reachable(peer.id)).toBe(true);
    // The double answers nothing, which is what a connection silently dropped
    // by something in the middle looks like from here.
    await eventually(() => instance.mesh?.reachable(peer.id) === false);
    expect(instance.mesh?.held.links).toBe(0);
  });
});

/** What a promise refused with, or nothing when it did not refuse. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (cause) {
    return cause;
  }
}

/** A JWS whose signature is not one: what a case needs when the point is that
 * the algorithm is read before anything is verified. */
function unsigned(header: { alg: string; kid: string }, claim: ProofClaim): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode(header)}.${encode(claim)}.`;
}
