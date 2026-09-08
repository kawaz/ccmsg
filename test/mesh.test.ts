import { afterEach, describe, expect, test } from "bun:test";
import { type InstanceId, type InstanceInfo } from "@ccmsg/protocol";
import { start } from "../src/instance/index.ts";
import {
  EphemeralKey,
  glareKeepsNew,
  MESH_VER,
  type ProofClaim,
  SelfIdentification,
  SelfIdentificationError,
} from "../src/mesh/index.ts";
import {
  endpoint,
  eventually,
  FakePeer,
  freePort,
  homeFor,
  reachable,
  release,
  startAt,
  withFakePeer,
} from "./cluster.ts";

afterEach(release);

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

describe("stopping tells the peers (§7.5)", () => {
  test("a peer that dialled here is told, rather than left to its heartbeat", async () => {
    // The link under test is one this instance accepted: the glare rule
    // decides which end dialled from a comparison of endpoint strings, so
    // whether a peer is told cannot be allowed to depend on which side of that
    // comparison it fell. Left to the listener's own teardown, a peer learns
    // whenever that gets round to it, and until then it keeps the link, keeps
    // answering `reachable`, and keeps routing here.
    const { instance, peer } = await withFakePeer();
    const reply = await peer.greet(instance.self);
    expect(reply["ok"]).toBe(true);
    expect(instance.mesh?.reachable(peer.id)).toBe(true);
    // The mesh alone, with the listener still up: what the peer hears has to
    // be the mesh letting the link go, not the socket disappearing under it.
    instance.mesh?.stop();
    await eventually(() => peer.closed);
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
