import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type InstanceId,
  type InstanceInfo,
  LAST_LIVE_RETENTION_MS,
  PROTOCOL_VERSION,
  type Sid,
} from "@ccmsg/protocol";
import { type Env, type Instance } from "../src/instance/index.ts";
import { Relay } from "../src/mesh/index.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { connectUds, connectWs, type LineClient } from "./client.ts";
import {
  endpoint,
  endpointOf,
  eventually,
  FakePeer,
  homeFor,
  leasePort,
  release,
  startAt,
} from "./cluster.ts";

/** What a cluster does with a request and with an event once the links of
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

/** Greet, and answer with the reply. */
async function greet(conn: HoldingClient, as: object): Promise<Record<string, unknown>> {
  conn.send({
    op: "hello",
    request_id: "hello",
    role: "user",
    protocol_version: PROTOCOL_VERSION,
    ...as,
  });
  return await reply(conn, "hello");
}

/** The next frame answering this request. The topic frames that arrive between
 * a request and its reply are put back rather than dropped: they are the
 * cluster's own events, and the case reading them next is entitled to them.
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
  test("an instance-local op about another instance's session is answered by that instance", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    // A holds no such session, so the routing table the relayed `peers` topic
    // is says the op belongs to B. The line comes back because the transcript
    // is in B's config home, and an instance looks in its own and no other
    // (M6) — so this answer could only have been decided there.
    await eventually(async () => {
      const answer = await ask(user, { op: "transcript_read", request_id: "read", sid: SID_ON_B });
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
      op: "transcript_read",
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
      const first = await ask(user, { op: "transcript_read", request_id: "warm", sid: SID_ON_B });
      return first["ok"] === true;
    });

    await b.stop();
    await eventually(() => a.mesh?.reachable(endpointOf(b)) === false);
    const gone = await ask(user, { op: "transcript_read", request_id: "gone", sid: SID_ON_B });
    expect(gone["ok"]).toBe(false);
    expect(errorOf(gone)).toBe("instance_unreachable");

    // The same instance, back where it was. Nothing had to be told: the link
    // is redialled and the op it could not carry goes through again.
    const returned = await startAt(homeB, { reconnectMinMs: 20 });
    await eventually(() => a.mesh?.reachable(endpointOf(returned)) === true);
    const back = await client(returned);
    await greet(back, { role: "session", sid: SID_ON_B });
    await eventually(async () => {
      const answer = await ask(user, { op: "transcript_read", request_id: "back", sid: SID_ON_B });
      return answer["ok"] === true;
    });
  });

  test("a session this cluster has never named is not found, while an unreachable instance makes it unreachable", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    // Everything is reachable, so nobody holding the sid means nobody has it.
    const missing = await ask(user, {
      op: "session_env_read",
      request_id: "missing",
      sid: UNKNOWN_SID,
    });
    expect(errorOf(missing)).toBe("session_not_found");

    await b.stop();
    await eventually(() => a.mesh?.reachable(endpointOf(b)) === false);
    // The same sid, and now an instance that might hold it cannot be asked. The
    // answer is about the instance rather than about the session (§4.2).
    const unsure = await ask(user, {
      op: "session_env_read",
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
    // what the connection is — an instance — and no instance-local op is open
    // to one.
    peer.send({
      op: "session_last_live_remove",
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
      op: "session_last_live_remove",
      request_id: "named",
      sid: UNKNOWN_SID,
      caller: { role: "user" },
    });
    expect((await peer.answer("named"))["ok"]).toBe(true);

    // And a role that table refuses is refused, however it fared where it
    // started: `session_last_live_remove` is open to a person and not to a
    // session.
    peer.send({
      op: "session_last_live_remove",
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
      op: "session_last_live_remove",
      request_id: "both",
      sid: UNKNOWN_SID,
      caller: { role: "user", sid: SID_ON_B },
    });
    expect(errorOf(await peer.answer("both"))).toBe("bad_request");
    peer.send({
      op: "session_last_live_remove",
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
      op: "transcript_read",
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
        op: "transcript_read",
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
    await ask(user, { op: "topic_subscribe", request_id: "sub", topic: "peers" });
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

describe("what the peers topic says about the instances (§7.5)", () => {
  test("a frame carries the sending instance's own view, and a relayed one keeps its sender's", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    await ask(user, { op: "topic_subscribe", request_id: "sub", topic: "peers" });

    // Two frames on one topic, and each says what its own sender can reach —
    // which is why the field travels per instance rather than being folded
    // into one list. Both see everything here; what the test pins is whose
    // view each frame carries.
    const views = new Map<string, InstanceInfo[]>();
    await eventually(async () => {
      const frame = await user.next();
      if (frame["topic"] !== "peers") return false;
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
    await ask(user, { op: "topic_subscribe", request_id: "sub", topic: "peers" });
    await b.stop();
    // No second greeting: the subscriber is already on the topic the view
    // rides on, which is what carrying it here is for (§7.5).
    await eventually(async () => {
      const frame = await user.next();
      if (frame["topic"] !== "peers" || frame["instance"] !== a.self) return false;
      const stated = (frame["data"] as { instances?: InstanceInfo[] }).instances ?? [];
      return stated.find((one) => one.id === b.self)?.reachable === false;
    });
  });
});

describe("what the instance says about the host link", () => {
  test("the peers that answer are what `instance_ping` reads the link off", async () => {
    const { a, b } = await pair();
    const user = await client(a);
    await greet(user, {});
    const up = await ask(user, { op: "instance_ping", request_id: "up" });
    expect(up["network"]).toBe("online");

    await b.stop();
    // Every configured peer silent at once is the link gone, which is a
    // different answer from the same instance having no mesh to read.
    await eventually(() => a.mesh?.reachable(endpointOf(b)) === false);
    const down = await ask(user, { op: "instance_ping", request_id: "down" });
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
    await ask(session, { op: "topic_subscribe", request_id: "inbox", topic: "inbox" });

    await eventually(async () => {
      const sent = await ask(user, {
        op: "message_send",
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
      op: "message_send",
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
    // two endpoint strings (§8.1), so a cluster has instances on both sides of
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
      await ask(watcher, { op: "topic_subscribe", request_id: "sub", topic: "peers" });

      await going.stop();
      // Told by the link ending, not by a heartbeat: the silence a heartbeat is
      // there for takes minutes to be called (§7.5, §8.3), so a notice that
      // arrives at all is one the closing link carried. And when it arrives the
      // answer is already there rather than on its way — which is what makes
      // the disconnection immediate, with no interval on this side to wait out.
      await eventually(async () => {
        const frame = await watcher.next();
        if (frame["topic"] !== "peers" || frame["instance"] !== staying.self) return false;
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
    // rather than an empty cluster (§7.5).
    expect(a.mesh?.relay.snapshot("peers").length).toBe(1);
    expect(a.mesh?.relay.unreachable(b.self)).toBe(true);
    await ask(user, { op: "topic_subscribe", request_id: "sub", topic: "peers" });
    await eventually(async () => {
      const frame = await user.next();
      return frame["topic"] === "peers" && frame["instance"] === b.self;
    });

    // Back, with nothing greeted to it this time. What it says now stands in
    // place of what it said before, rather than being merged with it.
    const returned = await startAt(homeB, { reconnectMinMs: 20 });
    await eventually(() => a.mesh?.reachable(endpointOf(returned)) === true);
    await eventually(() => a.mesh?.relay.unreachable(returned.self) === false);
    await eventually(() => {
      const held = a.mesh?.relay.snapshot("peers") ?? [];
      const value = held.find((one) => one.instance === returned.self)?.data;
      return (value as { peers?: unknown[] } | undefined)?.peers?.length === 0;
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
    // On the window, not past it: the value is still the cluster's.
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
    relay.accept(peer, "peers", { peers: [], last_live: [] });
    relay.accept(peer, "agents", {
      agents: [
        { sid: SID_ON_B, instance: peer, pid: 1, cwd: "/", kind: "interactive", started_at: 0 },
      ],
    });
    expect(relay.owner(SID_ON_B)).toBe(peer);
  });

  test("a session the peer has only in `last_live` is still found (§7.3)", () => {
    const relay = new Relay({ publish: () => undefined });
    const peer = "ws://127.0.0.1:9" as InstanceId;
    relay.accept(peer, "peers", {
      peers: [],
      last_live: [{ sid: SID_ON_B, instance: peer, last_seen_at: 0 }],
    });
    expect(relay.owner(SID_ON_B)).toBe(peer);
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

describe("the credentials and tokens the cluster shares (DR-0001 §2.6)", () => {
  test("a record written on one instance authenticates at the other", async () => {
    const { a, b } = await pair();
    // What a registration would have left behind, written where it happened.
    const minted = a.auth.mint("someone");
    await eventually(() => b.auth.admits(minted.session.access.value) !== undefined);
    expect(b.auth.admits(minted.session.access.value)?.sub).toBe("someone");

    // The endpoint the record travelled to takes the token on its own
    // handshake, which is the whole point of replicating it: the instance a
    // person registered at may be down.
    const client = await connectWs(addressOf(b), minted.session.access.value);
    client.send({ op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION });
    expect(await client.next()).toMatchObject({ ok: true });
    await client.close();
  });

  test("a rotation is carried to the instance that minted the family", async () => {
    const { a, b } = await pair();
    const minted = a.auth.mint("someone");
    await eventually(() => b.auth.records.byRefresh(minted.refresh.value) !== undefined);

    // B holds the family but may not write it, so it asks A — the single
    // writer — and answers with what A minted (§2.4).
    const rotated = await b.auth.refreshToken(minted.refresh.value);
    expect(rotated.session.sub).toBe("someone");
    expect(a.auth.admits(rotated.session.access.value)?.sub).toBe("someone");
  });

  test("a removal travels, and refuses the credential everywhere", async () => {
    const { a, b } = await pair();
    const minted = a.auth.mint("goes-away");
    await eventually(() => b.auth.admits(minted.session.access.value) !== undefined);
    a.auth.remove("goes-away");
    await eventually(() => b.auth.records.removed("goes-away"));
    expect(b.auth.admits(minted.session.access.value)).toBeUndefined();
  });
});

describe("registering at one instance with another's URL (DR-0001 §2.6)", () => {
  test("the issuer checks the URL and the code; the instance reached does the rest", async () => {
    const { a, b } = await pair();
    // A makes the URL and holds the secret and the six digits; the browser
    // lands on B, which knows neither.
    const issued = a.auth.issue({ endpoint: endpointOf(b) });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const origin = `http://${addressOf(b)}`;
    const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);

    // The wrong digits are refused by A, and the try is counted there.
    const challenge = await authChallenge(b, origin);
    const refused = await authPost(b, origin, "register", {
      token,
      code: issued.code === "000000" ? "111111" : "000000",
      credential: await authenticator.create({
        challenge: challenge.challenge,
        origin,
        userId: issued.user_id,
      }),
    });
    expect(refused.status).toBe(401);

    const second = await authChallenge(b, origin);
    const accepted = await authPost(b, origin, "register", {
      token,
      code: issued.code,
      challenge: second,
      credential: await authenticator.create({
        challenge: second.challenge,
        origin,
        userId: issued.user_id,
      }),
    });
    expect(accepted.status).toBe(200);
    const session = (await accepted.json()) as { sub: string; access: { value: string } };
    expect(session.sub).toBe(issued.sub);

    // The record was written at B, and reaches A the way every record does.
    await eventually(() => a.auth.records.credential(authenticator.credentialIdUrl) !== undefined);
    expect(a.auth.records.credential(authenticator.credentialIdUrl)?.user_handle).toBe(
      issued.user_id,
    );

    // The person authenticates at the endpoint the credential was registered
    // for, which is B.
    const asserted = await authChallenge(b, origin);
    const atB = await authPost(b, origin, "assert", {
      credential: await authenticator.get({ challenge: asserted.challenge, origin }),
      challenge: asserted,
    });
    expect(atB.status).toBe(200);

    // Not at A, even though A holds the same record and issued the URL: a
    // credential is good for the endpoint it names and no other, which is what
    // keeps one instance's passkey from being a way into its neighbour
    // (contract, `CredentialRecord.endpoint`).
    const elsewhere = `http://${addressOf(a)}`;
    const other = await authChallenge(a, elsewhere);
    const atA = await authPost(a, elsewhere, "assert", {
      credential: await authenticator.get({ challenge: other.challenge, origin: elsewhere }),
      challenge: other,
    });
    expect(atA.status).toBe(401);
  });
});

describe("a token reused at another instance (DR-0001 §2.4)", () => {
  test("the instance that minted the family is the one that fails it", async () => {
    const { a, b } = await pair();
    const minted = a.auth.mint("someone");
    // Twice, so the value the family started with is past the grace the
    // generation before the standing one gets: what is left of it is the digest
    // the family carries.
    const once = await a.auth.refreshToken(minted.refresh.value);
    const rotated = await a.auth.refreshToken(once.refresh.value);
    await eventually(() => b.auth.records.byRefresh(rotated.refresh.value) !== undefined);

    // The value A rotated away, presented at B. B may not write the family —
    // A minted it — so it asks A to rotate the value, and A finds what B found
    // and fails its own family (N1).
    const refused = await b.auth
      .refreshToken(minted.refresh.value)
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    expect(refused).toBeDefined();
    await eventually(() => a.auth.admits(rotated.session.access.value) === undefined);
    expect(a.auth.admits(rotated.session.access.value)).toBeUndefined();
    await eventually(() => b.auth.admits(rotated.session.access.value) === undefined);
  });
});

describe("authenticating where the challenge was not issued (DR-0001 §2.6)", () => {
  test("the instance reached verifies the assertion and spends the challenge at its issuer", async () => {
    const { a, b } = await pair();
    const originB = `http://${addressOf(b)}`;
    const issued = a.auth.issue({ endpoint: endpointOf(b) });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
    const registration = await authChallenge(b, originB);
    expect(
      (
        await authPost(b, originB, "register", {
          token,
          code: issued.code,
          challenge: registration,
          credential: await authenticator.create({
            challenge: registration.challenge,
            origin: originB,
            userId: issued.user_id,
          }),
        })
      ).status,
    ).toBe(200);
    await eventually(() => a.auth.records.credential(authenticator.credentialIdUrl) !== undefined);

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

/** One `/auth/*` request against an instance in the cluster. */
async function authPost(
  instance: Instance,
  origin: string,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`http://${addressOf(instance)}/auth/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
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
