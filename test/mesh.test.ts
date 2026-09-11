import { afterEach, describe, expect, test } from "bun:test";
import { type InstanceId, type InstanceInfo } from "@ccmsg/protocol";
import { start } from "../src/instance/index.ts";
import {
  EphemeralKey,
  glareKeepsNew,
  MESH_VER,
  type ProofClaim,
  PeerProbe,
  SelfEndpointError,
} from "../src/mesh/index.ts";
import {
  deadPort,
  endpoint,
  endpointOf,
  eventually,
  FakePeer,
  homeFor,
  leasePort,
  reachable,
  proxyTo,
  release,
  startAt,
  withFakePeer,
} from "./cluster.ts";

afterEach(release);

/** The peer list is written before anything binds (§7.1), so between choosing
 * an address and listening on it there is a gap that only the kernel's own
 * record of who holds the port keeps anyone else out of. These say the fixture
 * keeps that record standing, because a test that lost the race would fail as
 * this cluster's own fault rather than the machine's. */
describe("the addresses a test hands out", () => {
  test("a leased address is not free for anything else to be given", () => {
    const lease = leasePort();
    expect(() =>
      Bun.serve({ hostname: "127.0.0.1", port: lease.port, fetch: () => new Response("") }),
    ).toThrow();
  });

  test("two instances started at once each get the address they were promised", async () => {
    const [a, b] = [leasePort(), leasePort()];
    const peers = [endpoint(a.port), endpoint(b.port)];
    const [first, second] = await Promise.all([
      startAt(homeFor(a, peers), { reconnectMinMs: 20 }),
      startAt(homeFor(b, peers), { reconnectMinMs: 20 }),
    ]);
    expect([endpointOf(first), endpointOf(second)].sort()).toEqual([...peers].sort());
  });
});

describe("which endpoint this instance is (§7.1)", () => {
  test("the list settles onto this instance, and the peers are what is left", async () => {
    const lease = leasePort();
    const asleep = endpoint(deadPort());
    // The list names this instance too, which is what §8.2 says one file going
    // to every host looks like. It is taken out of what gets dialled.
    const instance = await startAt(homeFor(lease, [endpoint(lease.port), asleep]));
    expect(endpointOf(instance)).toBe(endpoint(lease.port));
    expect(instance.mesh?.peers).toEqual([asleep]);
    // A peer that did not answer is left out of the count rather than refused,
    // which is what let this start happen at all; unreachable now is not
    // unreachable for good, so it stays a peer to dial (DV-Q11).
    expect(reachable(instance, asleep)).toBe(false);
  });

  test("two instances given one list each settle on their own endpoint", async () => {
    const [a, b] = [leasePort(), leasePort()];
    const peers = [endpoint(a.port), endpoint(b.port)];
    // The same file, byte for byte, to both homes: neither is told which entry
    // is its own and each finds out from the probe that came back to it.
    const [first, second] = await Promise.all([
      startAt(homeFor(a, peers), { reconnectMinMs: 20 }),
      startAt(homeFor(b, peers), { reconnectMinMs: 20 }),
    ]);
    expect(endpointOf(first)).toBe(endpoint(a.port));
    expect(endpointOf(second)).toBe(endpoint(b.port));
  });

  test("an id is what the instance is called, and it is not the endpoint", async () => {
    const lease = leasePort();
    const instance = await startAt(homeFor(lease, [endpoint(lease.port)]));
    expect(instance.self).toMatch(/^[0-9a-f]{32}$/);
    expect(instance.self).not.toBe(endpointOf(instance));
  });

  test("a list that does not name this instance ends the start (§7.1)", async () => {
    // Every entry is somewhere else, so no probe comes back here and there is
    // nothing to be. Q2 of self-identification, refused at startup.
    const lease = leasePort();
    const env = homeFor(lease, [endpoint(deadPort())]);
    // `start` binds the address this home names, so the lease on it is given up
    // here rather than by `startAt`, which is what does it for a start expected
    // to run.
    await lease.release();
    expect(await refusal(start({ env, echoLog: false }))).toBeInstanceOf(SelfEndpointError);
  });

  test("a list naming only a live stranger ends the start (§7.1)", async () => {
    // The endpoint answers the probe, but the token does not come back here:
    // answering is not being us.
    const lease = leasePort();
    const stranger = leasePort();
    const env = homeFor(lease, [endpoint(stranger.port)]);
    await lease.release();
    expect(await refusal(start({ env, echoLog: false }))).toBeInstanceOf(SelfEndpointError);
  });

  test("two URLs that both reach this instance end the start (§7.1)", async () => {
    // A proxy in front of the instance, listed beside the address it forwards
    // to. Both probes land here, so two entries are this instance and neither
    // can be preferred: which of the two names a peer should compare as `aud`
    // is not something the protocol can decide, so the start is refused.
    const lease = leasePort();
    const alias = proxyTo(endpoint(lease.port));
    const env = homeFor(lease, [endpoint(lease.port), alias]);
    await lease.release();
    expect(await refusal(start({ env, echoLog: false }))).toBeInstanceOf(SelfEndpointError);
  });

  test("a refused start leaves its port bound to nobody (§7.1)", async () => {
    const lease = leasePort();
    const env = homeFor(lease, [endpoint(deadPort())]);
    await lease.release();
    expect(await refusal(start({ env, echoLog: false }))).toBeInstanceOf(SelfEndpointError);
    // The entry listener is up before the endpoint list is settled, so the
    // refusal has to give the port back: binding it again is what says it did.
    const after = Bun.serve({
      hostname: "127.0.0.1",
      port: lease.port,
      fetch: () => new Response(""),
    });
    expect(after.port).toBe(lease.port);
    await after.stop(true);
  });

  test("a token meant for another endpoint does not match (§7.2)", async () => {
    const probe = new PeerProbe();
    // Nothing was sent, so no token in existence is one of ours — which is what
    // a probe arriving from elsewhere is.
    probe.accept("00".repeat(16));
    const dead = endpoint(deadPort());
    expect(await refusal(probe.identify([dead]))).toBeInstanceOf(SelfEndpointError);
  });

  test("the table is gone once the run is over (§7.3)", async () => {
    const probe = new PeerProbe();
    const lease = leasePort();
    await startAt(homeFor(lease, [endpoint(lease.port)]));
    // A token accepted after the run cannot match anything, because the table
    // it would have been matched against no longer exists.
    probe.accept("11".repeat(16));
    const dead = endpoint(deadPort());
    expect(await refusal(probe.identify([dead]))).toBeInstanceOf(SelfEndpointError);
  });
});

describe("the mesh handshake (mesh-peer-auth §10.3)", () => {
  test("a greeting that proves itself is answered, and the peer becomes reachable", async () => {
    const { instance, peer } = await withFakePeer();
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(true);
    expect(reply["instance"]).toBe(instance.self);
    // The two are stated apart: the id says which instance answered, the
    // endpoint says where it is dialled, and neither follows from the other.
    expect(reply["endpoint"]).toBe(endpointOf(instance));
    const instances = reply["instances"] as InstanceInfo[];
    const held = instances.find((one) => one.id === peer.id);
    expect(held?.reachable).toBe(true);
    expect(held?.endpoint).toBe(peer.endpoint);
    expect(instance.mesh?.reachable(peer.endpoint)).toBe(true);
  });

  test("an id already answering elsewhere closes the newcomer (DR-0001 §2.1)", async () => {
    // Two endpoints, both on this instance's peer list, both naming one id.
    // The standing binding is what the operator's endpoint list has already
    // vouched for, so it is the second arrival that is turned away — which is
    // what an instance that has moved runs into while its old URL is still up.
    const real = leasePort();
    const firstLease = leasePort();
    const secondLease = leasePort();
    const peers = [endpoint(real.port), endpoint(firstLease.port), endpoint(secondLease.port)];
    const first = await FakePeer.at(firstLease);
    const second = await FakePeer.at(secondLease);
    second.id = first.id;
    const instance = await startAt(homeFor(real, peers));

    expect((await first.greet(endpointOf(instance)))["ok"]).toBe(true);
    expect(instance.mesh?.reachable(first.endpoint)).toBe(true);

    const refused = await second.greet(endpointOf(instance));
    expect(refused["ok"]).toBe(false);
    expect(instance.mesh?.reachable(second.endpoint)).toBe(false);
    // The one that was already there is untouched: the newcomer is what the
    // rule drops, not the binding.
    expect(instance.mesh?.reachable(first.endpoint)).toBe(true);
    const instances = instance.mesh?.instances() ?? [];
    expect(instances.find((one) => one.id === first.id)?.endpoint).toBe(first.endpoint);
  });

  test("a peer claiming to be this instance is refused (DR-0001 §2.1)", async () => {
    // What the instance at a moved instance's old URL looks like from the new
    // one. The binding this instance opens with is its own, so the rule that
    // keeps a standing binding covers it without a case of its own.
    const { instance, peer } = await withFakePeer();
    peer.id = instance.self;
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
    expect(instance.mesh?.reachable(peer.endpoint)).toBe(false);
  });

  test("a peer under a different id is bound beside the first", async () => {
    const real = leasePort();
    const firstLease = leasePort();
    const secondLease = leasePort();
    const peers = [endpoint(real.port), endpoint(firstLease.port), endpoint(secondLease.port)];
    const first = await FakePeer.at(firstLease);
    const second = await FakePeer.at(secondLease);
    const instance = await startAt(homeFor(real, peers));
    expect((await first.greet(endpointOf(instance)))["ok"]).toBe(true);
    expect((await second.greet(endpointOf(instance)))["ok"]).toBe(true);
    const instances = instance.mesh?.instances() ?? [];
    expect(instances.find((one) => one.id === first.id)?.endpoint).toBe(first.endpoint);
    expect(instances.find((one) => one.id === second.id)?.endpoint).toBe(second.endpoint);
  });

  test("an unknown handshake generation is refused (§5.7-1)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { ver: MESH_VER + 1 };
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
    expect(instance.mesh?.reachable(peer.endpoint)).toBe(false);
  });

  test("an `iss` that is not a configured peer is refused (§5.7-2)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { iss: endpoint(deadPort()) };
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("an `aud` that is not this instance is refused (§5.7-3)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { aud: peer.id };
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("an `iss` sharing our origin but not our path is refused (§5.7, §4.2)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { iss: `${peer.id}/other` };
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("an `aud` that merely starts with ours is refused (§5.7)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claim = { aud: `${instance.self}.evil` };
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("a proof stating something other than the greeting is refused (§5.7-4)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claimOverride = { aud: peer.id };
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
    expect(instance.mesh?.reachable(peer.endpoint)).toBe(false);
  });

  test("a proof answering another challenge is refused (§5.7-5)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claimOverride = { challenge: "22".repeat(16) };
    const reply = await peer.greet(endpointOf(instance));
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
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(true);
    // The challenge was spent when the first proof was read, so replaying it
    // finds no handshake — there is no record of it left to match against.
    peer.send({ mesh: "proof", jws: captured });
    await eventually(() => peer.closed);
    expect(instance.mesh?.reachable(peer.endpoint)).toBe(false);
  });

  test("an expired proof is refused (§5.7-6)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claimOverride = { exp: Math.floor(Date.now() / 1000) - 1 };
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("a signature that is not the served key's is refused (§5.7-7)", async () => {
    const { instance, peer } = await withFakePeer();
    // Signed by one key, and a different key handed out under the same id: the
    // shape a peer of one origin takes when it answers for another (§6.3).
    const other = new EphemeralKey();
    peer.jwk = () => ({ ...other.jwk(), kid: peer.key.kid });
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("an algorithm outside the allowed set is refused (§5.7-7)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.proof = (claim) => unsigned({ alg: "HS256", kid: peer.key.kid }, claim);
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("`alg: none` is refused (§5.7-7)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.proof = (claim) => unsigned({ alg: "none", kid: peer.key.kid }, claim);
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("a proof naming another key than the greeting is refused (§5.7-8)", async () => {
    const { instance, peer } = await withFakePeer();
    const other = new EphemeralKey();
    peer.proof = (claim) => other.proof(claim);
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("a key served under another id than the proof names is refused (§5.7-8)", async () => {
    const { instance, peer } = await withFakePeer();
    peer.jwk = () => ({ ...peer.key.jwk(), kid: "33".repeat(16) });
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });

  test("a request before the acknowledgement ends the connection (§5.8)", async () => {
    const { instance, peer } = await withFakePeer();
    // The key request is what the greeting waits for, so holding it back leaves
    // the handshake open while the peer speaks out of turn.
    peer.onKeyAsked = () => {
      peer.send({ op: "instance.ping", request_id: "early" });
    };
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
    await eventually(() => peer.closed);
    expect(instance.mesh?.reachable(peer.endpoint)).toBe(false);
  });

  test("the key cannot be asked for on the connection being authenticated (§6)", async () => {
    const { instance, peer } = await withFakePeer();
    // There is no such frame and no such op: the key lives behind an HTTP path
    // and nothing on this connection answers for it. A frame that is neither is
    // read as speaking before the acknowledgement, which ends the connection.
    peer.onKeyAsked = () => {
      peer.send({ mesh: "jwk_req", kid: peer.key.kid, challenge: "44".repeat(16) });
    };
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(false);
  });
});

describe("what a handshake leaves behind (mesh-peer-auth §10.5)", () => {
  test("nothing is held once a handshake has finished", async () => {
    const { instance, peer } = await withFakePeer();
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(true);
    const held = instance.mesh?.held;
    // One link, and no key and no challenge: the receiving end mints no key,
    // and the challenge was spent when the proof was read.
    expect(held).toEqual({ keys: 0, handshakes: 0, links: 1 });
  });

  test("a refused handshake leaves no less behind than a successful one", async () => {
    const { instance, peer } = await withFakePeer();
    peer.claimOverride = { challenge: "55".repeat(16) };
    await peer.greet(endpointOf(instance));
    expect(instance.mesh?.held).toEqual({ keys: 0, handshakes: 0, links: 0 });
  });

  test("several handshakes at once come back to nothing held", async () => {
    const real = leasePort();
    const leases = [leasePort(), leasePort(), leasePort()];
    const peers = [endpoint(real.port), ...leases.map((lease) => endpoint(lease.port))];
    const doubles = await Promise.all(leases.map((lease) => FakePeer.at(lease)));
    const instance = await startAt(homeFor(real, peers));
    const replies = await Promise.all(doubles.map((peer) => peer.greet(endpointOf(instance))));
    expect(replies.map((reply) => reply["ok"])).toEqual([true, true, true]);
    expect(instance.mesh?.held).toEqual({ keys: 0, handshakes: 0, links: 3 });
  });

  test("a dialling instance destroys its key once it is acknowledged (§7)", async () => {
    const [a, b] = [leasePort(), leasePort()];
    const peers = [endpoint(a.port), endpoint(b.port)];
    const first = await startAt(homeFor(a, peers));
    const second = await startAt(homeFor(b, peers));
    await eventually(() => first.mesh?.reachable(endpointOf(second)) === true);
    await eventually(() => second.mesh?.reachable(endpointOf(first)) === true);
    // The key exists for one handshake and is gone the moment the peer says it
    // has finished verifying, so a settled mesh holds none.
    expect(first.mesh?.held.keys).toBe(0);
    expect(second.mesh?.held.keys).toBe(0);
  });

  test("stopping lets the links and the keys go", async () => {
    const { instance, peer } = await withFakePeer();
    await peer.greet(endpointOf(instance));
    await instance.stop();
    expect(instance.mesh?.held).toEqual({ keys: 0, handshakes: 0, links: 0 });
  });
});

describe("glare (mesh-peer-auth §8.1)", () => {
  test("both ends decide the same way, and it is the smaller `iss` that dialled", () => {
    const [small, large] = ["http://a/", "http://b/"] as [InstanceId, InstanceId];
    // From `small`'s side: the connection it dialled stays, the one it accepted
    // goes. From `large`'s side, the mirror of that. Between them exactly one
    // connection survives, which is what the rule is for.
    expect(glareKeepsNew(small, large, true)).toBe(true);
    expect(glareKeepsNew(small, large, false)).toBe(false);
    expect(glareKeepsNew(large, small, true)).toBe(false);
    expect(glareKeepsNew(large, small, false)).toBe(true);
  });

  test("two instances that dial each other end up holding one link each", async () => {
    const [a, b] = [leasePort(), leasePort()];
    const peers = [endpoint(a.port), endpoint(b.port)];
    // Started together and retrying quickly, so both ends dial while the other
    // is still deciding — which is the situation the rule exists for.
    const [first, second] = await Promise.all([
      startAt(homeFor(a, peers), { reconnectMinMs: 20 }),
      startAt(homeFor(b, peers), { reconnectMinMs: 20 }),
    ]);
    await eventually(() => first.mesh?.reachable(endpointOf(second)) === true);
    await eventually(() => second.mesh?.reachable(endpointOf(first)) === true);
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
    const reply = await peer.greet(endpointOf(instance));
    expect(reply["ok"]).toBe(true);
    expect(instance.mesh?.reachable(peer.endpoint)).toBe(true);
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
    await peer.greet(endpointOf(instance));
    expect(instance.mesh?.reachable(peer.endpoint)).toBe(true);
    // The double answers nothing, which is what a connection silently dropped
    // by something in the middle looks like from here.
    await eventually(() => instance.mesh?.reachable(peer.endpoint) === false);
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
