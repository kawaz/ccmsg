import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type InstanceId,
  type InstanceInfo,
  LAST_LIVE_RETENTION_MS,
  liveness,
  type PeerInfo,
  PROTOCOL_VERSION,
  type Sid,
  type UserId,
} from "@ccmsg/protocol";
import { type Env, type Instance } from "../src/instance/index.ts";
import { Relay } from "../src/mesh/index.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { connectUds, connectWs, type LineClient } from "./client.ts";
import { knownAt, TEST_USER } from "./person.ts";
import {
  endpoint,
  endpointOf,
  eventually,
  FakePeer,
  homeFor,
  leasePort,
  release,
  startAt,
} from "./mesh.ts";

/** What a mesh does with a request and with an event once the links of
 * mesh-peer-auth are up: daemon-v2 §11.5's daemon-specific cases.
 *
 * Everything here runs against instances speaking over real sockets, because
 * what is under test is what one instance does with another's answer — a
 * double on either end would be stating the answer the test is asking about. */

const closing: LineClient[] = [];

afterEach(async () => {
  for (const client of closing.splice(0)) await client.close();
  await release();
});

/** A client that keeps the frames a reply search steps over.
 *
 * Waiting for one request's answer means reading whatever arrives first, and
 * what arrives first may be the topic frame the case is about. Held in the
 * order they came, they are still there for the next `next()`. */
interface HoldingClient extends LineClient {
  /** What a search stepped over and has not been asked for yet. */
  readonly held: Record<string, unknown>[];
  /** The next frame off the connection itself, past anything held. */
  fresh(): Promise<Record<string, unknown>>;
}

async function client(instance: Instance): Promise<HoldingClient> {
  const conn = await connectUds(instance.paths.socket);
  closing.push(conn);
  const held: Record<string, unknown>[] = [];
  return {
    ...conn,
    held,
    fresh: () => conn.next(),
    next: async () => held.shift() ?? (await conn.next()),
  };
}

/** Greet, and answer with the reply. The role is the op's now, so a caller
 * naming one greets under that op and a caller naming none greets as a
 * person. */
async function greet(
  conn: HoldingClient,
  as: { role?: "session" | "user"; sid?: string },
): Promise<Record<string, unknown>> {
  const { role, ...named } = as;
  conn.send({
    op: `hello.${role ?? "user"}`,
    request_id: "hello",
    protocol_version: PROTOCOL_VERSION,
    ...named,
  });
  return await reply(conn, "hello");
}

/** The next frame answering this request. The topic frames that arrive between
 * a request and its reply are put back rather than dropped: they are the
 * mesh's own events, and the case reading them next is entitled to them.
 * Each is stepped over once — what was already held is searched before the
 * connection is read again, and goes back in front of whatever is behind it. */
async function reply(conn: HoldingClient, requestId: string): Promise<Record<string, unknown>> {
  const skipped: Record<string, unknown>[] = [];
  try {
    for (;;) {
      const frame = conn.held.shift() ?? (await conn.fresh());
      if (frame["request_id"] === requestId) return frame;
      skipped.push(frame);
    }
  } finally {
    conn.held.unshift(...skipped);
  }
}

async function ask(
  conn: HoldingClient,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = frame["request_id"] as string;
  conn.send(frame);
  return await reply(conn, requestId);
}

function errorOf(frame: Record<string, unknown>): string | undefined {
  return (frame["error"] as { code?: string } | undefined)?.code;
}

/** A transcript in one instance's config home, and the line that says it is
 * that instance's.
 *
 * What makes a forwarded op's answer tell the two instances apart: only the
 * instance the session greeted was told where its transcript is, so a reply
 * carrying this line is one that was decided there (M6). */
const TRANSCRIPT_LINE = '{"note":"this is the other instance\'s home"}';

function transcriptIn(env: Env, sid: Sid): void {
  const dir = join(env.CLAUDE_CONFIG_DIR as string, "projects", "test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), `${TRANSCRIPT_LINE}\n`);
}

const SID_ON_B = "11111111-1111-4111-8111-111111111111" as Sid;
/** A second session id, for a case telling one row from another. */
const SID = "22222222-2222-4222-8222-222222222222" as Sid;
const UNKNOWN_SID = "22222222-2222-4222-8222-222222222222" as Sid;
const OTHER_SID = "33333333-3333-4333-8333-333333333333" as Sid;

/** Two instances that have found each other, with a session greeted to the
 * second one. */
async function pair(): Promise<{
  a: Instance;
  b: Instance;
  /** B's home, so a test that stops B can start it again where it was. */
  homeB: Env;
  session: HoldingClient;
}> {
  const [first, second] = [leasePort(), leasePort()];
  const peers = [endpoint(first.port), endpoint(second.port)];
  const homeB = homeFor(second, peers);
  transcriptIn(homeB, SID_ON_B);
  const [a, b] = await Promise.all([
    startAt(homeFor(first, peers), { reconnectMinMs: 20 }),
    startAt(homeB, { reconnectMinMs: 20 }),
  ]);
  await eventually(() => a.mesh?.reachable(endpointOf(b)) === true);
  await eventually(() => b.mesh?.reachable(endpointOf(a)) === true);
  const session = await client(b);
  await greet(session, { role: "session", sid: SID_ON_B });
  return { a, b, homeB, session };
}

describe("forwarding an op (§7.3)", () => {
  test("an owner_instance op about another instance's session is answered by that instance", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    // A holds no such session, so the routing table the relayed `peers` topic
    // is says the op belongs to B. The line comes back because the transcript
    // is in B's config home, and an instance looks in its own and no other
    // (M6) — so this answer could only have been decided there.
    await eventually(async () => {
      const answer = await ask(user, { op: "transcript.read", request_id: "read", sid: SID_ON_B });
      return (
        answer["ok"] === true &&
        (answer["lines"] as string[] | undefined)?.includes(TRANSCRIPT_LINE) === true
      );
    });
    expect(b.self).not.toBe(a.self);
  });

  test("a request that has already been here is not passed round again", async () => {
    const { a } = await pair();
    const user = await client(a);
    await greet(user, {});
    // The shape a cycle in the routing produces: a request arriving at an
    // instance its own `hops` already names.
    const answer = await ask(user, {
      op: "transcript.read",
      request_id: "loop",
      sid: SID_ON_B,
      hops: [a.self],
    });
    expect(answer["ok"]).toBe(false);
    expect(errorOf(answer)).toBe("instance_unreachable");
  });

  test("an op for an instance that cannot be reached says so, and succeeds once it is back", async () => {
    const { a, b, homeB } = await pair();
    const user = await client(a);
    await greet(user, {});
    await eventually(async () => {
      const first = await ask(user, { op: "transcript.read", request_id: "warm", sid: SID_ON_B });
      return first["ok"] === true;
    });

    await b.stop();
    await eventually(() => a.mesh?.reachable(endpointOf(b)) === false);
    const gone = await ask(user, { op: "transcript.read", request_id: "gone", sid: SID_ON_B });
    expect(gone["ok"]).toBe(false);
    expect(errorOf(gone)).toBe("instance_unreachable");

    // The same instance, back where it was. Nothing had to be told: the link
    // is redialled and the op it could not carry goes through again.
    const returned = await startAt(homeB, { reconnectMinMs: 20 });
    await eventually(() => a.mesh?.reachable(endpointOf(returned)) === true);
    const back = await client(returned);
    await greet(back, { role: "session", sid: SID_ON_B });
    await eventually(async () => {
      const answer = await ask(user, { op: "transcript.read", request_id: "back", sid: SID_ON_B });
      return answer["ok"] === true;
    });
  });

  test("a session this mesh has never named is not found, while an unreachable instance makes it unreachable", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    // Everything is reachable, so nobody holding the sid means nobody has it.
    const missing = await ask(user, {
      op: "session.env.read",
      request_id: "missing",
      sid: UNKNOWN_SID,
    });
    expect(errorOf(missing)).toBe("session_not_found");

    await b.stop();
    await eventually(() => a.mesh?.reachable(endpointOf(b)) === false);
    // The same sid, and now an instance that might hold it cannot be asked. The
    // answer is about the instance rather than about the session (§4.2).
    const unsure = await ask(user, {
      op: "session.env.read",
      request_id: "unsure",
      sid: UNKNOWN_SID,
    });
    expect(errorOf(unsure)).toBe("instance_unreachable");
  });
});

describe("who a forwarded request runs as (§7.3)", () => {
  /** A real instance with a peer under the test's control on its link. */
  async function linked(): Promise<{ instance: Instance; peer: FakePeer }> {
    const real = leasePort();
    const peerLease = leasePort();
    const peers = [endpoint(real.port), endpoint(peerLease.port)];
    const peer = await FakePeer.at(peerLease);
    const instance = await startAt(homeFor(real, peers));
    expect((await peer.greet(endpointOf(instance)))["ok"]).toBe(true);
    return { instance, peer };
  }

  test("a request naming no caller runs as the link, which the table already answers", async () => {
    const { peer } = await linked();
    // Every field of the envelope but the caller, including a `from_instance`
    // pointing anywhere at all. There is nobody named, so the request runs as
    // what the connection is — an instance — and no owner_instance op is open
    // to one.
    peer.send({
      op: "session.forget",
      request_id: "nameless",
      sid: UNKNOWN_SID,
      from_instance: peer.id,
      hops: [peer.id],
    });
    const refused = await peer.answer("nameless");
    expect(refused["ok"]).toBe(false);
    expect(errorOf(refused)).toBe("forbidden");
  });

  test("a caller the peer states is believed, because the link is what was proven", async () => {
    const { peer } = await linked();
    // The same op, now naming a caller. Nothing about this envelope is signed
    // and the peer could have made the caller up — which is the assumption
    // being written down here: a peer that passed mesh-peer-auth is an
    // instance on the peer list, and a peer list is one deployment (§8.2), so
    // what it says about who called is taken as said. What is not taken is the
    // outcome: the role below is read against this instance's own table.
    peer.send({
      op: "session.forget",
      request_id: "named",
      sid: UNKNOWN_SID,
      caller: { role: "user" },
    });
    expect((await peer.answer("named"))["ok"]).toBe(true);

    // And a role that table refuses is refused, however it fared where it
    // started: `session.forget` is open to a person and not to a
    // session.
    peer.send({
      op: "session.forget",
      request_id: "as-session",
      sid: UNKNOWN_SID,
      caller: { role: "session", sid: SID_ON_B },
    });
    expect(errorOf(await peer.answer("as-session"))).toBe("forbidden");
  });

  test("a caller whose role and sid disagree is a malformed request", async () => {
    const { peer } = await linked();
    // The contract says a sid is there exactly when the role is a session, and
    // leaves a violation to the instance. Two callers are described here and
    // neither is chosen (contract, `CallerIdentity`).
    peer.send({
      op: "session.forget",
      request_id: "both",
      sid: UNKNOWN_SID,
      caller: { role: "user", sid: SID_ON_B },
    });
    expect(errorOf(await peer.answer("both"))).toBe("bad_request");
    peer.send({
      op: "session.forget",
      request_id: "neither",
      sid: UNKNOWN_SID,
      caller: { role: "session" },
    });
    expect(errorOf(await peer.answer("neither"))).toBe("bad_request");
  });

  test("a session's visible range is the same across the mesh as it is at home", async () => {
    const { a } = await pair();
    // A session may read its own transcript and no other's (§11.2). The
    // subject is on B, so the rule has to survive the forwarding: the caller
    // travels in the envelope and the destination applies its own scope to it.
    const other = await client(a);
    await greet(other, { role: "session", sid: OTHER_SID });
    const refused = await ask(other, {
      op: "transcript.read",
      request_id: "someone-else",
      sid: SID_ON_B,
    });
    expect(errorOf(refused)).toBe("not_found");

    // The same op, over the same link, for the same transcript — and it comes
    // back. So the refusal above was the scope of the caller B was told about,
    // not a file B could not find.
    const person = await client(a);
    await greet(person, {});
    await eventually(async () => {
      const answer = await ask(person, {
        op: "transcript.read",
        request_id: "as-a-person",
        sid: SID_ON_B,
      });
      return (
        answer["ok"] === true &&
        (answer["lines"] as string[] | undefined)?.includes(TRANSCRIPT_LINE) === true
      );
    });
  });
});

describe("relaying events (§7.4)", () => {
  test("a frame from another instance reaches a subscriber here under the instance that produced it", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    await ask(user, { op: "topic.subscribe", request_id: "sub", topic: "peers" });
    // The session greeted B, so the row naming it is B's to state. A passes the
    // frame on without recomputing it, which is what `instance` still saying B
    // means here.
    const frames: Record<string, unknown>[] = [];
    await eventually(async () => {
      frames.push(await user.next());
      return frames.some(
        (frame) =>
          frame["topic"] === "peers" &&
          frame["instance"] === b.self &&
          ((frame["data"] as { peers?: { sid: string }[] }).peers ?? []).some(
            (row) => row.sid === SID_ON_B,
          ),
      );
    });
  });
});

describe("what the instances topic says (§7.5)", () => {
  test("a frame carries the sending instance's own view, and a relayed one keeps its sender's", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    await ask(user, { op: "topic.subscribe", request_id: "sub", topic: "instances" });

    // Two frames on one topic, and each says what its own sender can reach —
    // which is why the field travels per instance rather than being folded
    // into one list. Both see everything here; what the test pins is whose
    // view each frame carries.
    const views = new Map<string, InstanceInfo[]>();
    await eventually(async () => {
      const frame = await user.next();
      if (frame["topic"] !== "instances") return false;
      const stated = (frame["data"] as { instances?: InstanceInfo[] }).instances;
      if (stated !== undefined) views.set(frame["instance"] as string, stated);
      return views.has(a.self) && views.has(b.self);
    });
    for (const [sender, stated] of views) {
      // Every instance lists itself as reachable and names the other.
      expect(stated.find((one) => one.id === sender)?.reachable).toBe(true);
      // Only the rows a handshake has settled carry an id; both have here.
      const named = stated.flatMap((one) => (one.id === undefined ? [] : [one.id]));
      expect(named.sort()).toEqual([a.self, b.self].sort());
    }
  });

  test("a link going down shows up on the topic, without asking again", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    await ask(user, { op: "topic.subscribe", request_id: "sub", topic: "instances" });
    await b.stop();
    // No second greeting: the subscriber is already on the topic the view
    // rides on, which is what carrying it here is for (§7.5).
    await eventually(async () => {
      const frame = await user.next();
      if (frame["topic"] !== "instances" || frame["instance"] !== a.self) return false;
      const stated = (frame["data"] as { instances?: InstanceInfo[] }).instances ?? [];
      return stated.find((one) => one.id === b.self)?.reachable === false;
    });
  });
});

describe("what the instance says about the host link", () => {
  test("the peers that answer are what `instance.ping` reads the link off", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    const up = await ask(user, { op: "instance.ping", request_id: "up" });
    expect(up["network"]).toBe("online");

    await b.stop();
    // Every configured peer silent at once is the link gone, which is a
    // different answer from the same instance having no mesh to read.
    await eventually(() => a.mesh?.reachable(endpointOf(b)) === false);
    const down = await ask(user, { op: "instance.ping", request_id: "down" });
    expect(down["network"]).toBe("offline");
  });

  test("a link going down is announced to every client, once", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    // No subscription: the event is about the connection's own instance rather
    // than about a topic, so it arrives on any connection that greeted.
    await greet(user, {});
    await b.stop();
    const frames: Record<string, unknown>[] = [];
    await eventually(async () => {
      frames.push(await user.next());
      return frames.some((frame) => frame["ev"] === "net_online");
    });
    expect(frames.filter((frame) => frame["ev"] === "net_online")).toEqual([
      { ev: "net_online", instance: a.self, online: false },
    ]);
  });
});

describe("a message to a session on another instance (§4)", () => {
  test("it is carried there and handed over", async () => {
    const { a, session } = await pair();
    const user = await client(a);
    await greet(user, {});
    await ask(session, { op: "topic.subscribe", request_id: "inbox", topic: "inbox" });

    await eventually(async () => {
      const sent = await ask(user, {
        op: "message.send",
        request_id: `send-${Date.now()}`,
        to: SID_ON_B,
        text: "over here",
      });
      return sent["ok"] === true && sent["delivered"] === true;
    });
    // The session's own instance is what published it, so the frame arrives on
    // the connection that greeted there.
    await eventually(async () => {
      const frame = await session.next();
      const messages = (frame["data"] ?? []) as { text?: string }[];
      return messages.some((message) => message.text === "over here");
    });
  });

  test("an unreachable owner is a reason rather than a session that does not exist", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    await b.stop();
    await eventually(() => a.mesh?.reachable(endpointOf(b)) === false);
    const sent = await ask(user, {
      op: "message.send",
      request_id: "held",
      to: SID_ON_B,
      text: "nobody home",
    });
    expect(sent["ok"]).toBe(true);
    expect(sent["reason"]).toBe("instance_unreachable");
  });
});

describe("what a disconnected instance leaves behind (§7.5, DV-Q12)", () => {
  test("an instance that stops is out of reach at once, whichever end dialled the link", async () => {
    // Which end holds the dialled half of a link is decided by comparing the
    // two endpoint strings (§8.1), so a mesh has instances on both sides of
    // that comparison and both have to be covered. Ports are handed out by the
    // kernel, so the two cases are chosen here rather than waited for: stopping
    // the smaller `iss` leaves the survivor holding a link it accepted, and
    // stopping the larger leaves it holding one it dialled.
    for (const stopSmaller of [true, false]) {
      const [first, second] = [leasePort(), leasePort()];
      const peers = [endpoint(first.port), endpoint(second.port)];
      const [one, two] = await Promise.all([
        startAt(homeFor(first, peers), { reconnectMinMs: 20 }),
        startAt(homeFor(second, peers), { reconnectMinMs: 20 }),
      ]);
      await eventually(() => one.mesh?.reachable(endpointOf(two)) === true);
      await eventually(() => two.mesh?.reachable(endpointOf(one)) === true);
      const ordered = [one, two].sort((left, right) => (left.self < right.self ? -1 : 1));
      const [going, staying] = stopSmaller ? ordered : [...ordered].reverse();

      // The survivor's own account of its links, on the topic a subscriber is
      // told of a disconnection on (§7.5). Subscribed before the stop, so what
      // arrives after it is the notice itself.
      const watcher = await client(staying);
      await greet(watcher, {});
      await ask(watcher, { op: "topic.subscribe", request_id: "sub", topic: "instances" });

      await going.stop();
      // Told by the link ending, not by a heartbeat: the silence a heartbeat is
      // there for takes minutes to be called (§7.5, §8.3), so a notice that
      // arrives at all is one the closing link carried. And when it arrives the
      // answer is already there rather than on its way — which is what makes
      // the disconnection immediate, with no interval on this side to wait out.
      await eventually(async () => {
        const frame = await watcher.next();
        if (frame["topic"] !== "instances" || frame["instance"] !== staying.self) return false;
        const instances = (frame["data"] as { instances?: InstanceInfo[] }).instances;
        return instances?.some((held) => held.id === going.self && !held.reachable) === true;
      });
      expect(staying.mesh?.reachable(endpointOf(going))).toBe(false);
      await release();
    }
  });

  test("its value is kept, marked, and replaced when it comes back", async () => {
    const { a, b, homeB } = await pair();
    const user = await client(a);
    await greet(user, {});
    await eventually(() => a.mesh?.relay.snapshot("peers").length === 1);

    await b.stop();
    await eventually(() => a.mesh?.reachable(endpointOf(b)) === false);
    // Still there, and marked: a subscriber that arrives now sees B's sessions
    // rather than an empty mesh (§7.5).
    expect(a.mesh?.relay.snapshot("peers").length).toBe(1);
    expect(a.mesh?.relay.unreachable(b.self)).toBe(true);
    await ask(user, { op: "topic.subscribe", request_id: "sub", topic: "peers" });
    await eventually(async () => {
      const frame = await user.next();
      return frame["topic"] === "peers" && frame["instance"] === b.self;
    });

    // Back, with nothing greeted to it this time. What it says now stands in
    // place of what it said before rather than being merged with it: the
    // session it held is one it has lost across the restart, so the row a
    // subscriber ends up with is that one and not the live row from before.
    const returned = await startAt(homeB, { reconnectMinMs: 20 });
    await eventually(() => a.mesh?.reachable(endpointOf(returned)) === true);
    await eventually(() => a.mesh?.relay.unreachable(returned.self) === false);
    await eventually(() => {
      const held = a.mesh?.relay.snapshot("peers") ?? [];
      const value = held.find((one) => one.instance === returned.self)?.data;
      const rows = (value as { peers?: PeerInfo[] } | undefined)?.peers ?? [];
      const only = rows[0];
      return (
        rows.length === 1 && only !== undefined && liveness(only, Date.now()) === "disappeared"
      );
    });
  });

  test("it is given up once it has been gone for the retention window", () => {
    // Stated against the clock rather than against a link, because a week is
    // the window and nothing here runs on a timer to be waited out: what drops
    // the value is the next read past it (§7.5).
    let now = 1_000_000;
    const relayed: string[] = [];
    const relay = new Relay({
      now: () => now,
      publish: (topic) => {
        relayed.push(topic);
      },
    });
    const peer = "ws://127.0.0.1:9" as InstanceId;
    relay.accept(peer, "peers", { peers: [{ sid: SID_ON_B, instance: peer }] });
    expect(relayed).toEqual(["peers"]);
    expect(relay.owner(SID_ON_B)).toBe(peer);

    relay.lost(peer);
    now += LAST_LIVE_RETENTION_MS;
    // On the window, not past it: the value is still the mesh's.
    expect(relay.snapshot("peers").length).toBe(1);
    now += 1;
    expect(relay.snapshot("peers")).toEqual([]);
    expect(relay.owner(SID_ON_B)).toBeUndefined();
    expect(relay.retained).toEqual({ instances: 0, marked: 0 });
  });

  test("a session the peer only knows through its harness scan is still found (§7.3)", () => {
    // A session that has not greeted yet has no row in `peers`, but the
    // instance holding it already reports it on `agents`.
    const relay = new Relay({ publish: () => undefined });
    const peer = "ws://127.0.0.1:9" as InstanceId;
    relay.accept(peer, "peers", { peers: [] });
    relay.accept(peer, "agents", {
      agents: [
        { sid: SID_ON_B, instance: peer, pid: 1, cwd: "/", kind: "interactive", started_at: 0 },
      ],
    });
    expect(relay.owner(SID_ON_B)).toBe(peer);
  });

  test("a peer's terminals are relayed as rows of their own, matched by their id", () => {
    const passed: { topic: string; data: unknown }[] = [];
    const relay = new Relay({ publish: (topic, data) => passed.push({ topic, data }) });
    const peer = "ws://127.0.0.1:9" as InstanceId;
    const row = { instance: peer, id: "hyoui:%17", state: "running", command: ["zsh"], pid: 7 };

    relay.accept(peer, "terminals", { terminals: [row] });
    relay.accept(peer, "terminals", { terminals: [row] });
    relay.accept(peer, "terminals", {
      terminals: [{ instance: peer, id: "hyoui:%17", removed: true }],
    });

    expect(passed.map((frame) => (frame.data as { terminals: unknown[] }).terminals)).toEqual([
      [row],
      [{ instance: peer, id: "hyoui:%17", removed: true }],
    ]);
    expect(relay.snapshot("terminals")).toEqual([{ instance: peer, data: { terminals: [] } }]);
  });

  test("a session the peer has lost is still found (§7.3)", () => {
    const relay = new Relay({ publish: () => undefined });
    const peer = "ws://127.0.0.1:9" as InstanceId;
    relay.accept(peer, "peers", {
      peers: [{ sid: SID_ON_B, instance: peer, runs: [], stopped_at: 0, last_seen_at: 0 }],
    });
    expect(relay.owner(SID_ON_B)).toBe(peer);
  });

  test("a row the peer removed is no longer found", () => {
    const relay = new Relay({ publish: () => undefined });
    const peer = "ws://127.0.0.1:9" as InstanceId;
    relay.accept(peer, "peers", {
      peers: [{ sid: SID_ON_B, instance: peer, runs: [{ connected: true }] }],
    });
    relay.accept(peer, "peers", { peers: [{ sid: SID_ON_B, instance: peer, removed: true }] });
    expect(relay.owner(SID_ON_B)).toBeUndefined();
  });

  test("what travels on is the part of a frame that said something", () => {
    const passed: { topic: string; data: unknown }[] = [];
    const relay = new Relay({ publish: (topic, data) => passed.push({ topic, data }) });
    const peer = "ws://127.0.0.1:9" as InstanceId;
    const row = { sid: SID_ON_B, instance: peer, runs: [{ connected: true }] };

    relay.accept(peer, "peers", { peers: [row] });
    // The peer restating a row it has already stated tells this instance
    // nothing, so nothing reaches its subscribers either (M5, per element).
    relay.accept(peer, "peers", { peers: [row] });
    // And a frame that moves one of two rows carries that one.
    const other = { sid: SID, instance: peer, runs: [{ connected: true }] };
    relay.accept(peer, "peers", { peers: [other] });
    relay.accept(peer, "peers", { peers: [{ ...row, session_status: "ready" }] });

    expect(passed.map((frame) => (frame.data as { peers: unknown[] }).peers)).toEqual([
      [row],
      [other],
      [{ ...row, session_status: "ready" }],
    ]);
  });

  test("an opening frame from a peer is its list restated, not changes folded in", () => {
    const passed: unknown[] = [];
    const relay = new Relay({ publish: (_topic, data) => passed.push(data) });
    const peer = "ws://127.0.0.1:9" as InstanceId;
    relay.accept(peer, "peers", {
      peers: [
        { sid: SID_ON_B, instance: peer, runs: [{ connected: true }] },
        { sid: SID, instance: peer, runs: [{ connected: true }] },
      ],
    });

    // The peer came back and opens with what it holds now, which is one of the
    // two. The other is gone from its list and from nothing else, so the
    // removal is this instance's to state onward.
    passed.length = 0;
    relay.accept(
      peer,
      "peers",
      { peers: [{ sid: SID, instance: peer, runs: [{ connected: true }] }] },
      true,
    );

    expect(passed).toEqual([{ peers: [{ sid: SID_ON_B, instance: peer, removed: true }] }]);
    expect(relay.owner(SID_ON_B)).toBeUndefined();
  });

  test("a topic of any other granularity is not relayed", () => {
    const relay = new Relay({ publish: () => undefined });
    // `inbox` names one instance's topic while its value belongs to a session,
    // and a frame of it carries no way to say whose. Holding one here would
    // offer another session's messages to whoever subscribed.
    relay.accept("ws://127.0.0.1:9" as InstanceId, "inbox", [{ mid: "x" }]);
    expect(relay.snapshot("inbox")).toEqual([]);
  });
});

describe("the records the mesh shares admit a person where they are an owner (contract, DR-0030 §3)", () => {
  test("a granting written on one instance admits the person at the other, and nothing does before it", async () => {
    const { a, b } = await pair();
    // What a registration would have left behind, written where it happened:
    // a passkey at A's page, and the granting of A.
    const originA = `http://${addressOf(a)}`;
    await knownAt(a.auth, originA);
    const minted = await a.auth.mint(TEST_USER, originA);
    await eventually(() => b.auth.records.byAccess(minted.session.access.value) !== undefined);
    // B holds the family and the passkey, and admits nobody on them: the
    // person owns A.
    expect(b.auth.admits(minted.session.access.value)).toBeUndefined();
    expect(b.auth.knownOrigins()).toEqual([]);

    // One granting, written at A for B — the peers trust each other equally —
    // and the token opens B on B's own handshake, which is the whole point of
    // replicating the records: the instance a person registered at may be
    // down. The page is still A's, and that is what B holds the `Origin` to.
    await a.auth.grant(TEST_USER, [b.self], { kind: "instance", instance: a.self });
    await eventually(() => b.auth.admits(minted.session.access.value) !== undefined);
    expect(b.auth.admits(minted.session.access.value)?.user).toBe(TEST_USER);
    expect(b.auth.knownOrigins()).toEqual([originA]);
    const client = await connectWs(addressOf(b), minted.session.access.value, { origin: originA });
    client.send({ op: "hello.user", request_id: "1", protocol_version: PROTOCOL_VERSION });
    expect(await client.next()).toMatchObject({ ok: true });
    await client.close();
  });

  test("a rotation is written where the refresh landed, and the minting instance reads it back", async () => {
    const { a, b } = await pair();
    const originA = `http://${addressOf(a)}`;
    await knownAt(a.auth, originA);
    await a.auth.grant(TEST_USER, [b.self], { kind: "instance", instance: a.self });
    const minted = await a.auth.mint(TEST_USER, originA);
    await eventually(() => b.auth.records.byRefresh(minted.refresh.value) !== undefined);

    // B holds the family and, owning being what admits the person, writes it:
    // nothing is carried to A, which reads the rotation back like any record.
    const rotated = await b.auth.refreshToken(minted.refresh.value, {
      reason: "reconnect",
      ip: "203.0.113.7",
      userAgent: "a browser",
    });
    expect(rotated.session.user).toBe(TEST_USER);
    await eventually(() => a.auth.records.byRefresh(rotated.refresh.value) !== undefined);
    expect(a.auth.admits(rotated.session.access.value)?.user).toBe(TEST_USER);
    const [held] = a.auth.records.families();
    expect(held?.body.iss).toBe(a.self);
    expect(held?.body.last_refresh).toMatchObject({
      reason: "reconnect",
      ip: "203.0.113.7",
      user_agent: "a browser",
    });
    // And A rotates it on from there.
    expect((await a.auth.refreshToken(rotated.refresh.value)).session.user).toBe(TEST_USER);
  });

  test("a removal travels, and closes the door everywhere the granting opened", async () => {
    const { a, b } = await pair();
    const originA = `http://${addressOf(a)}`;
    await knownAt(a.auth, originA);
    await a.auth.grant(TEST_USER, [b.self], { kind: "instance", instance: a.self });
    const minted = await a.auth.mint(TEST_USER, originA);
    await eventually(() => b.auth.admits(minted.session.access.value) !== undefined);
    const client = await connectWs(addressOf(b), minted.session.access.value, { origin: originA });
    client.send({ op: "hello.user", request_id: "1", protocol_version: PROTOCOL_VERSION });
    expect(await client.next()).toMatchObject({ ok: true });

    // Let go at A, for B: the mark reaches B, which closes the connection the
    // granting had admitted and refuses the token from then on.
    await a.auth.revoke(TEST_USER, b.self);
    await client.whenClosed;
    expect(b.auth.records.owns(TEST_USER, b.self)).toBe(false);
    expect(b.auth.admits(minted.session.access.value)).toBeUndefined();
    // A is untouched by it: the person still owns A.
    expect(a.auth.admits(minted.session.access.value)?.user).toBe(TEST_USER);
  });
});

describe("an enrolment completes wherever it lands (contract, DR-0030 §4)", () => {
  test("a URL one instance issued registers at another, and hands the person the instance it names", async () => {
    const { a, b } = await pair();
    const originA = `http://${addressOf(a)}`;
    // A issued the URL, B is where the browser's POST landed. B checks the
    // ceremony and writes the records itself, and asks A only for what A alone
    // holds: the secret that signed the URL and the count of tries against the
    // six digits.
    const issued = await a.auth.issue({ purpose: "create_user" });
    const user = issued.user as UserId;
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const atB = await authChallenge(b, originA);
    const made = await authPost(b, originA, "register", {
      token: tokenOf(issued.url),
      code: issued.code,
      challenge: atB,
      credential: await authenticator.create({
        challenge: atB.challenge,
        origin: originA,
        userId: user,
      }),
    });
    expect(made.status).toBe(200);
    expect(((await made.json()) as { user: string }).user).toBe(user);
    expect(b.auth.records.credential(authenticator.credentialIdUrl)).toBeDefined();
    // The URL was spent at its issuer.
    expect(a.auth.heldCounts.pending).toBe(0);

    // What the person owns is what the URL granted as it was issued: A, and
    // not the instance that happened to receive the ceremony.
    await eventually(() => b.auth.records.owns(user, a.self));
    expect(b.auth.records.owns(user, b.self)).toBe(false);
    await eventually(() => a.auth.records.credential(authenticator.credentialIdUrl) !== undefined);
    const asserting = async (at: Instance): Promise<number> => {
      const challenge = await authChallenge(at, originA);
      return (
        await authPost(at, originA, "assert", {
          credential: await authenticator.get({ challenge: challenge.challenge, origin: originA }),
          challenge,
        })
      ).status;
    };
    expect(await asserting(a)).toBe(200);
    // Refused before anything is read: no owner of B made a passkey at that
    // page.
    expect(await asserting(b)).toBe(403);

    // The other URL: B hands itself to the person, and its URL is spent at A.
    // The passkey they hold asserts, the six digits say they chose B, and the
    // granting is written where the answer landed.
    const adding = await b.auth.issue({ purpose: "add_owner", origin: originA });
    const atA = await authChallenge(a, originA);
    const enrolled = await authPost(a, originA, "enroll", {
      token: tokenOf(adding.url),
      code: adding.code,
      challenge: atA,
      credential: await authenticator.get({ challenge: atA.challenge, origin: originA }),
    });
    expect(enrolled.status).toBe(200);
    expect(((await enrolled.json()) as { user: string }).user).toBe(user);
    expect(a.auth.records.owns(user, b.self)).toBe(true);
    await eventually(() => b.auth.records.owns(user, b.self));
    expect(await asserting(b)).toBe(200);
  });

  test("a URL naming an issuer the mesh does not reach is refused, and spends nothing", async () => {
    const { a, b } = await pair();
    const originA = `http://${addressOf(a)}`;
    const issued = await a.auth.issue({ purpose: "create_user" });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const token = tokenOf(issued.url);
    const [header, body, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(body as string, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const elsewhere = `${header ?? ""}.${Buffer.from(
      JSON.stringify({ ...claims, iss: "e".repeat(32) }),
    ).toString("base64url")}.${signature ?? ""}`;
    const atB = await authChallenge(b, originA);
    const refused = await authPost(b, originA, "register", {
      token: elsewhere,
      code: issued.code,
      challenge: atB,
      credential: await authenticator.create({
        challenge: atB.challenge,
        origin: originA,
        userId: issued.user,
      }),
    });
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "instance_unreachable",
    );
    expect(a.auth.heldCounts.pending).toBe(1);
    expect(b.auth.records.credentials()).toEqual([]);
  });
});

describe("a token reused at another instance (contract, DR-0030 §5)", () => {
  test("whichever instance the retired value reaches fails the family, and the failure travels", async () => {
    const { a, b } = await pair();
    const originA = `http://${addressOf(a)}`;
    await knownAt(a.auth, originA);
    await a.auth.grant(TEST_USER, [b.self], { kind: "instance", instance: a.self });
    const minted = await a.auth.mint(TEST_USER, originA);
    // Twice, so the value the family started with is past the grace the
    // generation before the standing one gets: what is left of it is the digest
    // the family carries.
    const once = await a.auth.refreshToken(minted.refresh.value);
    const rotated = await a.auth.refreshToken(once.refresh.value);
    await eventually(() => b.auth.records.byRefresh(rotated.refresh.value) !== undefined);

    // The value A rotated away, presented at B. B finds the digest in the
    // family it holds and fails it there; the mark reaches A like any record.
    expect(
      await b.auth
        .refreshToken(minted.refresh.value)
        .then(() => undefined)
        .catch((cause: unknown) => (cause as { code?: string }).code),
    ).toBe("auth_invalid");
    expect(b.auth.admits(rotated.session.access.value)).toBeUndefined();
    await eventually(() => a.auth.admits(rotated.session.access.value) === undefined);
  });
});

describe("authenticating where the challenge was not issued (contract, DR-0021)", () => {
  test("the instance reached verifies the assertion and spends the challenge at its issuer", async () => {
    const { a, b } = await pair();
    const originB = `http://${addressOf(b)}`;
    // Registered at B, with a URL B issued: what crosses the mesh here is the
    // challenge, not the registration.
    const issued = await b.auth.issue({ purpose: "create_user" });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const registration = await authChallenge(b, originB);
    expect(
      (
        await authPost(b, originB, "register", {
          token: tokenOf(issued.url),
          code: issued.code,
          challenge: registration,
          credential: await authenticator.create({
            challenge: registration.challenge,
            origin: originB,
            userId: issued.user,
          }),
        })
      ).status,
    ).toBe(200);

    // A issues the challenge; B receives the answer. B verifies the assertion
    // itself and asks A to spend the challenge, which is the whole of what it
    // needs A for.
    const challenge = await authChallenge(a, `http://${addressOf(a)}`);
    expect(challenge.issuer).toBe(a.self);
    const asserted = await authPost(b, originB, "assert", {
      credential: await authenticator.get({ challenge: challenge.challenge, origin: originB }),
      challenge,
    });
    expect(asserted.status).toBe(200);

    // And it is good once, wherever it is presented: A spent it.
    const again = await authPost(b, originB, "assert", {
      credential: await authenticator.get({ challenge: challenge.challenge, origin: originB }),
      challenge,
    });
    expect(again.status).toBe(401);
  });
});

/** The token an enrolment URL carries in its fragment. */
function tokenOf(url: string): string {
  return url.slice(url.indexOf("#enroll=") + "#enroll=".length);
}

/** One `/auth/*` request against an instance in the mesh. */
async function authPost(
  instance: Instance,
  origin: string,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`http://${addressOf(instance)}/auth/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

async function authChallenge(
  instance: Instance,
  origin: string,
): Promise<{ challenge: string; issuer: string; expires_at: number }> {
  const answer = await authPost(instance, origin, "challenge", {});
  return (await answer.json()) as { challenge: string; issuer: string; expires_at: number };
}

/** Where an instance's WebSocket is bound, for a client that dials it. */
function addressOf(instance: Instance): string {
  return instance.http[0] as string;
}
