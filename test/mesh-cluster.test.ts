import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type InstanceId,
  LAST_LIVE_RETENTION_MS,
  PROTOCOL_VERSION,
  type Sid,
} from "@ccmsg/protocol";
import { type Env, type Instance } from "../src/instance/index.ts";
import { Relay } from "../src/mesh/index.ts";
import { connectUds, type LineClient } from "./client.ts";
import { endpoint, eventually, FakePeer, freePort, homeFor, release, startAt } from "./cluster.ts";

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

async function client(instance: Instance): Promise<LineClient> {
  const conn = await connectUds(instance.paths.socket);
  closing.push(conn);
  return conn;
}

/** Greet, and answer with the reply. */
async function greet(conn: LineClient, as: object): Promise<Record<string, unknown>> {
  conn.send({
    op: "hello",
    request_id: "hello",
    role: "user",
    protocol_version: PROTOCOL_VERSION,
    ...as,
  });
  return await reply(conn, "hello");
}

/** The next frame answering this request, skipping the topic frames that may
 * arrive between a request and its reply. */
async function reply(conn: LineClient, requestId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = await conn.next();
    if (frame["request_id"] === requestId) return frame;
  }
}

async function ask(
  conn: LineClient,
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

/** Two instances that have found each other, with a session greeted to the
 * second one. */
async function pair(): Promise<{
  a: Instance;
  b: Instance;
  /** B's home, so a test that stops B can start it again where it was. */
  homeB: Env;
  session: LineClient;
}> {
  const [first, second] = [freePort(), freePort()];
  const peers = [endpoint(first), endpoint(second)];
  const homeB = homeFor(second, peers);
  transcriptIn(homeB, SID_ON_B);
  const [a, b] = await Promise.all([
    startAt(homeFor(first, peers), { reconnectMinMs: 20 }),
    startAt(homeB, { reconnectMinMs: 20 }),
  ]);
  await eventually(() => a.mesh?.reachable(b.self) === true);
  await eventually(() => b.mesh?.reachable(a.self) === true);
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
    await eventually(() => a.mesh?.reachable(b.self) === false);
    const gone = await ask(user, { op: "transcript_read", request_id: "gone", sid: SID_ON_B });
    expect(gone["ok"]).toBe(false);
    expect(errorOf(gone)).toBe("instance_unreachable");

    // The same instance, back where it was. Nothing had to be told: the link
    // is redialled and the op it could not carry goes through again.
    const returned = await startAt(homeB, { reconnectMinMs: 20 });
    await eventually(() => a.mesh?.reachable(returned.self) === true);
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
    await eventually(() => a.mesh?.reachable(b.self) === false);
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

describe("what the destination decides for itself (§7.3)", () => {
  test("a peer's request is put through this instance's own table, and its envelope names nobody", async () => {
    const realPort = freePort();
    const peerPort = freePort();
    const peer = new FakePeer(peerPort);
    const instance = await startAt(homeFor(realPort, [endpoint(realPort), endpoint(peerPort)]));
    expect((await peer.greet(instance.self))["ok"]).toBe(true);

    // A `session`-only op, forwarded with an envelope claiming to come from
    // anywhere at all. There is no field in it that names a caller, so the only
    // thing the destination can read is the link — which is a peer, not a
    // session — and the op is refused here however it fared where it started.
    peer.send({
      op: "session_stopping",
      request_id: "as-session",
      sid: SID_ON_B,
      from_instance: "ws://127.0.0.1:1",
      hops: ["ws://127.0.0.1:1"],
    });
    const refused = await peer.answer("as-session");
    expect(refused["ok"]).toBe(false);
    expect(errorOf(refused)).toBe("forbidden");

    // An op the same link may make: the refusal above is this instance's table
    // being applied, not the link being shut out of everything.
    peer.send({ op: "session_last_live_remove", request_id: "as-user", sid: UNKNOWN_SID });
    expect((await peer.answer("as-user"))["ok"]).toBe(true);
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
    await eventually(() => a.mesh?.reachable(b.self) === false);
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
  test("its value is kept, marked, and replaced when it comes back", async () => {
    const { a, b, homeB } = await pair();
    const user = await client(a);
    await greet(user, {});
    await eventually(() => a.mesh?.relay.snapshot("peers").length === 1);

    await b.stop();
    await eventually(() => a.mesh?.reachable(b.self) === false);
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
    await eventually(() => a.mesh?.reachable(returned.self) === true);
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

  test("a topic of any other granularity is not relayed", () => {
    const relay = new Relay({ publish: () => undefined });
    // `inbox` names one instance's topic while its value belongs to a session,
    // and a frame of it carries no way to say whose. Holding one here would
    // offer another session's messages to whoever subscribed.
    relay.accept("ws://127.0.0.1:9" as InstanceId, "inbox", [{ mid: "x" }]);
    expect(relay.snapshot("inbox")).toEqual([]);
  });
});
