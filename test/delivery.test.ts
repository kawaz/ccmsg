import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOX_MAX_PER_SID,
  INBOX_RETENTION_MS,
  type InboxMessage,
  type InboxRemovedReason,
  type Liveness,
  type MessageSendResult,
  OP_SCHEMAS,
  type PeerInfo,
  type SessionRun,
  type Sid,
  TOPIC_SCHEMAS,
  validationErrors,
} from "@ccmsg/protocol";
import {
  Delivery,
  DisabledDirectRoute,
  type DirectOutcome,
  type DirectRoute,
  Inbox,
  inboxPath,
  messagingHandlers,
  Notify,
  sessionLabel,
} from "../src/messaging/index.ts";
import { Sessions } from "../src/sessions/index.ts";
import { Topics } from "../src/topics/index.ts";
import { connAs, OTHER_SID, SELF, SELF_ENDPOINT, SID, TestConn } from "./frames.ts";
import { unthrottled } from "./clock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccmsg-inbox-"));
  dirs.push(dir);
  return dir;
}

const THIRD_SID = "11112222-3333-4444-8555-666677778888";
const REPO_ROOT = "/repos/a-repo";

/** A run of a session nothing is connected to, which is what a harness's state
 * file names. */
const UNCONNECTED_RUN: SessionRun = {
  pid: 4242,
  started_at: 1_756_000_000_000,
  connected: false,
};

/** What a row has to say for a session to stand where it does, one entry per
 * value the contract's `liveness` answers with.
 *
 * This is the join between the two things §11.4 keeps apart: a case says where
 * its destination stands, and this says which observations put it there.
 * Nothing here names a standing to the rule — `liveness` is what turns these
 * into one — and the map is exhaustive over the contract's own type, so a value
 * added there fails to compile until it has a row of its own. */
const OBSERVED: Record<Liveness, Pick<PeerInfo, "runs" | "stopped_at">> = {
  // One process is running it, which is the ordinary session.
  alive: { runs: [{ connected: true }] },
  // Two are, which is the one standing no message is taken for at all.
  duplicated: { runs: [UNCONNECTED_RUN, { ...UNCONNECTED_RUN, pid: 4243 }] },
  // Nothing is running it, and it said it was going.
  paused: { runs: [], stopped_at: 1_757_000_000_000 },
  // Nothing is running it, and it went without a word.
  disappeared: { runs: [] },
};

/** The sessions domain as delivery sees it: the rows per sid and the two lists.
 *
 * What stands in for `Sessions` here is where a row's observations come from —
 * a directory, a connection, a gateway — and not what they mean. The meaning is
 * the contract's own `liveness`, so a reason delivery returns is one that rule
 * derived, and a change to it reaches these cases. */
class FakeSessions {
  readonly rows = new Map<Sid, PeerInfo>();
  readonly connected: PeerInfo[] = [];
  readonly lastLive: PeerInfo[] = [];

  row(sid: Sid): PeerInfo | undefined {
    return this.rows.get(sid);
  }

  peerRows(): PeerInfo[] {
    return [...this.connected, ...this.lastLive];
  }

  /** A row that puts a session where `standing` says, so a case naming a
   * standing says which observations is what puts it there. */
  in(sid: Sid, standing: Liveness): void {
    this.rows.set(sid, {
      sid,
      instance: SELF,
      repo: "a-repo",
      ws: "main",
      cwd: `${REPO_ROOT}/main`,
      repo_root: REPO_ROOT,
      session_status: "ready",
      ...OBSERVED[standing],
    });
  }

  live(sid: Sid, over: Partial<PeerInfo> = {}): void {
    const row: PeerInfo = {
      sid,
      instance: SELF,
      repo: "a-repo",
      ws: "main",
      cwd: `${REPO_ROOT}/main`,
      repo_root: REPO_ROOT,
      protocol_version: 2,
      session_status: "ready",
      ...OBSERVED["alive"],
      ...over,
    };
    this.rows.set(sid, row);
    this.connected.push(row);
  }

  gone(sid: Sid, standing: "paused" | "disappeared", repoRoot = REPO_ROOT): void {
    const row: PeerInfo = {
      sid,
      instance: SELF,
      repo: "a-repo",
      ws: "main",
      cwd: `${repoRoot}/main`,
      repo_root: repoRoot,
      last_seen_at: 1_757_000_000_000,
      session_status: "ready",
      ...OBSERVED[standing],
    };
    this.rows.set(sid, row);
    this.lastLive.push(row);
  }
}

/** Route (a) as a stub, for the one outcome that is delivery's to handle
 * rather than the route's: a session that turned the message away (§4.4). */
class StubDirectRoute implements DirectRoute {
  constructor(private readonly outcome: DirectOutcome) {}
  send(): Promise<DirectOutcome> {
    return Promise.resolve(this.outcome);
  }
  close(): void {}
}

/** Route (a) as a script: one outcome per send, in order, and a note of what it
 * was asked to carry. What the offer of §4.3 is about is the order of those
 * sends and where they stop, neither of which one fixed outcome can state. */
class ScriptedDirectRoute implements DirectRoute {
  readonly carried: InboxMessage[] = [];
  /** Run while a send is in flight, so a test can have something else happen
   * partway through an offer. */
  during: ((message: InboxMessage) => void | Promise<void>) | undefined;

  constructor(private readonly outcomes: DirectOutcome[]) {}

  async send(_sid: Sid, message: InboxMessage): Promise<DirectOutcome> {
    this.carried.push(message);
    // A real send gives up the turn on a socket; this gives it up on nothing,
    // which is what lets a subscribe land in the middle of an offer.
    await Promise.resolve();
    void this.during?.(message);
    return this.outcomes.shift() ?? "unavailable";
  }

  close(): void {}

  texts(): string[] {
    return this.carried.map((message) => message.text);
  }
}

interface Rig {
  sessions: FakeSessions;
  topics: Topics;
  inbox: Inbox;
  delivery: Delivery;
  dir: string;
  send: (from: TestConn, to: Sid, text?: string) => Promise<MessageSendResult>;
}

function rig(
  over: {
    direct?: DirectRoute;
    dir?: string;
    log?: (message: string, fields: Record<string, unknown>) => void;
  } = {},
): Rig {
  const dir = over.dir ?? stateDir();
  const sessions = new FakeSessions();
  const topics = new Topics(SELF, new Set(), undefined, unthrottled());
  const inbox = new Inbox(inboxPath(dir), over.log);
  inbox.load();
  const delivery = new Delivery({
    self: SELF,
    sessions,
    inbox,
    direct: over.direct ?? new DisabledDirectRoute(),
    publish: (topic, data, instance, to) => topics.publish(topic, data, instance, to),
    listeners: (topic, to) => topics.subscriberCount(topic, to),
  });
  const notify = new Notify({
    self: SELF,
    label: (sid) => sessionLabel(sessions, sid),
    publish: (topic, data, instance) => topics.publish(topic, data, instance),
    duplicated: () => false,
  });
  topics.attach("inbox", delivery);
  topics.attach("notify", notify);
  const send = async (from: TestConn, to: Sid, text = "hi") => {
    const result = await messagingHandlers(delivery, notify)["message.send"]({
      op: "message.send",
      conn: from,
      args: { op: "message.send", request_id: "1", to, text },
      identity: from.identity.state === "settled" ? from.identity : undefined,
    });
    return result as MessageSendResult;
  };
  return { sessions, topics, inbox, delivery, dir, send };
}

/** A subscribed session, which is what route (b) needs to exist at all.
 *
 * Its snapshot is dropped unless a test asks to keep it: every subscribe
 * answers one, and a test about what arrives afterwards is about the frames
 * after that one. */
async function listening(topics: Topics, sid: Sid, keepSnapshot = false): Promise<TestConn> {
  const conn = connAs("session", sid);
  expect(await topics.subscribe(conn, "inbox")).toBe("ok");
  conn.flush();
  if (!keepSnapshot) conn.sent.splice(0);
  return conn;
}

/** A person watching, whose subscription is a view rather than a delivery. */
async function watching(topics: Topics, keepSnapshot = false): Promise<TestConn> {
  const conn = new TestConn({ state: "settled", role: "user" });
  expect(await topics.subscribe(conn, "inbox")).toBe("ok");
  conn.flush();
  if (!keepSnapshot) conn.sent.splice(0);
  return conn;
}

function inboxFrames(conn: TestConn): Record<string, unknown>[] {
  return conn.topics().filter((frame) => frame["topic"] === "inbox");
}

/** The messages one frame carries, which is the whole payload for a snapshot
 * and the one that just arrived for a change (§6.2). */
function messagesOf(frame: Record<string, unknown> | undefined): InboxMessage[] {
  return (frame?.["data"] ?? []) as InboxMessage[];
}

function problems(result: MessageSendResult): string[] {
  return validationErrors(OP_SCHEMAS["message.send"].response, {
    ok: true,
    request_id: "1",
    ...result,
  });
}

describe("delivery", () => {
  test("a listening session is handed the message, and nothing is held", async () => {
    const { sessions, topics, inbox, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);
    const recipient = await listening(topics, OTHER_SID);

    const result = await send(connAs("session", SID), OTHER_SID);

    expect(result).toEqual({ delivered: true });
    expect(problems(result)).toEqual([]);
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
    const frames = inboxFrames(recipient);
    expect(frames).toHaveLength(1);
    expect(validationErrors(TOPIC_SCHEMAS.inbox, frames[0] as object)).toEqual([]);
    const carried = messagesOf(frames[0])[0];
    expect(carried?.text).toBe("hi");
    expect(carried?.from).toBe(SID);
  });

  test("the person at the web UI is a sender in their own right", async () => {
    const { sessions, topics, send } = rig();
    sessions.live(OTHER_SID);
    const recipient = await listening(topics, OTHER_SID);

    // A person greets with a role and no sid, which is what tells them apart
    // from a session: the sender is the literal rather than a missing id.
    const person = new TestConn({ state: "settled", role: "user" });
    const result = await send(person, OTHER_SID);

    expect(result).toEqual({ delivered: true });
    const frame = inboxFrames(recipient)[0];
    expect(validationErrors(TOPIC_SCHEMAS.inbox, frame as object)).toEqual([]);
    const carried = messagesOf(frame)[0];
    expect([carried?.from, carried?.from_label]).toEqual(["user", "user"]);
  });

  test("a message is only pushed to the session it names", async () => {
    const { sessions, topics, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);
    sessions.live(THIRD_SID);
    const recipient = await listening(topics, OTHER_SID);
    const bystander = await listening(topics, THIRD_SID);

    await send(connAs("session", SID), OTHER_SID);

    expect(inboxFrames(recipient)).toHaveLength(1);
    expect(inboxFrames(bystander)).toEqual([]);
  });

  test("what was held comes out when the session subscribes, and stays out", async () => {
    const { sessions, topics, inbox, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);

    const result = await send(connAs("session", SID), OTHER_SID, "held");
    expect(result.delivered).toBe(false);
    expect(inbox.undelivered(OTHER_SID)).toHaveLength(1);

    const recipient = await listening(topics, OTHER_SID, true);
    const frames = inboxFrames(recipient);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.["snapshot"]).toBe(true);
    expect(messagesOf(frames[0])[0]?.text).toBe("held");
    // Delivered is delivered: a second subscriber does not receive it again.
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
    expect(messagesOf(inboxFrames(await listening(topics, OTHER_SID, true))[0])).toEqual([]);
  });

  test("a person sees what is waiting, named by who it is for", async () => {
    const { sessions, topics, inbox, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);
    const watcher = await watching(topics);

    const result = await send(connAs("session", SID), OTHER_SID);

    expect(result.delivered).toBe(false);
    const frames = inboxFrames(watcher);
    expect(frames).toHaveLength(1);
    expect(validationErrors(TOPIC_SCHEMAS.inbox, frames[0] as object)).toEqual([]);
    // A person holds every session's inbox in one subscription, so a row that
    // did not name its recipient could not be placed against any of them.
    expect(messagesOf(frames[0])[0]?.to).toBe(OTHER_SID);
    // Looking at it moved nothing: a person is not who it was addressed to.
    expect(inbox.undelivered(OTHER_SID)).toHaveLength(1);
  });

  test("a person subscribing is answered with every inbox, and empties none of them", async () => {
    const { sessions, topics, inbox, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);
    sessions.live(THIRD_SID);
    await send(connAs("session", SID), OTHER_SID, "for one");
    await send(connAs("session", SID), THIRD_SID, "for another");

    const watcher = await watching(topics, true);

    const carried = messagesOf(inboxFrames(watcher)[0]);
    expect(carried.map((message) => [message.to, message.text])).toEqual([
      [OTHER_SID, "for one"],
      [THIRD_SID, "for another"],
    ]);
    expect(inbox.undelivered(OTHER_SID)).toHaveLength(1);
    expect(inbox.undelivered(THIRD_SID)).toHaveLength(1);
  });

  test("a session's own rows say nothing by naming the session they reached", async () => {
    const { sessions, topics, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);
    const recipient = await listening(topics, OTHER_SID);

    await send(connAs("session", SID), OTHER_SID);

    expect(messagesOf(inboxFrames(recipient)[0])[0]?.to).toBeUndefined();
  });

  test("every way out of an inbox reaches the watchers as a removal, and says which", async () => {
    const { sessions, topics, inbox, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);
    sessions.live(THIRD_SID);
    const watcher = await watching(topics);

    // Delivered: the session takes what was waiting for it.
    await send(connAs("session", SID), OTHER_SID, "waited");
    await listening(topics, OTHER_SID);
    // Dropped: the oldest goes to make room for a newer one.
    for (let n = 0; n <= INBOX_MAX_PER_SID; n += 1) {
      await send(connAs("session", SID), THIRD_SID, `n${n}`);
    }
    // Expired: the window ran out with nobody having taken it.
    inbox.undelivered(THIRD_SID, Date.now() + INBOX_RETENTION_MS + 1);

    const reasons = new Set(
      inboxFrames(watcher)
        .flatMap((frame) => (frame["data"] ?? []) as { removed?: true; reason?: string }[])
        .filter((element) => element.removed === true)
        .map((element) => element.reason),
    );
    expect(reasons).toEqual(new Set(["delivered", "dropped", "expired"]));
    for (const frame of inboxFrames(watcher)) {
      expect(validationErrors(TOPIC_SCHEMAS.inbox, frame as object)).toEqual([]);
    }
  });

  test("a held record the contract cannot state is dropped rather than replayed into the view", async () => {
    // The file outlives the contract that wrote it: this is a line from a
    // spelling of `mid` the contract has since outgrown. Replayed as if it
    // were current it would be one row of the person's view, and the whole
    // frame is what the reader refuses for it.
    const dir = stateDir();
    const held = (mid: string, text: string) =>
      JSON.stringify({
        v: "add",
        sid: OTHER_SID,
        message: { mid, from: SID, from_label: SID, text, sent_at: Date.now() },
      });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      inboxPath(dir),
      `${held("ws://localhost/x/2", "from an older contract")}\n${held(`${SELF}/7`, "current")}\n`,
    );

    const logged: { message: string; fields: Record<string, unknown> }[] = [];
    const { topics, inbox } = rig({
      dir,
      log: (message, fields) => logged.push({ message, fields }),
    });

    expect(inbox.undelivered(OTHER_SID).map((message) => message.text)).toEqual(["current"]);
    const view = await watching(topics, true);
    const frames = inboxFrames(view);
    expect(frames).toHaveLength(1);
    expect(validationErrors(TOPIC_SCHEMAS.inbox, frames[0] as object)).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.message).toBe("dropped an inbox record the contract cannot state");
    expect(logged[0]?.fields["why"]).not.toEqual([]);
  });

  test("a message that goes straight out on the topic is stated as arriving and leaving", async () => {
    const { sessions, topics, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);
    await listening(topics, OTHER_SID);
    const watcher = await watching(topics);

    await send(connAs("session", SID), OTHER_SID, "straight through");

    const elements = inboxFrames(watcher).flatMap(
      (frame) => (frame["data"] ?? []) as { text?: string; removed?: true; reason?: string }[],
    );
    expect(elements.map((element) => element.text ?? element.reason)).toEqual([
      "straight through",
      "delivered",
    ]);
  });

  test("a sid nobody knows fails the op rather than filling an inbox", async () => {
    const { sessions, inbox, send } = rig();
    sessions.live(SID);

    expect(send(connAs("session", SID), OTHER_SID)).rejects.toThrow(/no session/);
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
  });
});

describe("why a message is waiting (§4.2)", () => {
  /** The classification is the whole input: one row per state the sessions
   * domain can answer, and the reason that follows from it. A reason reached
   * some other way would not be in this table. */
  /** One entry per value the contract's `liveness` answers with, and what
   * becomes of a message addressed to a session standing there. A reason
   * reached some other way would not be in this table, and a standing the
   * contract adds fails to compile until it is. */
  const OUTCOME: Record<Liveness, MessageSendResult["reason"] | "refused"> = {
    alive: "preparing",
    duplicated: "refused",
    paused: "paused",
    disappeared: "disappeared",
  };

  for (const [standing, outcome] of Object.entries(OUTCOME) as [
    Liveness,
    (typeof OUTCOME)[Liveness],
  ][]) {
    if (outcome === "refused") continue;
    test(`${standing} is ${outcome}`, async () => {
      const { sessions, send } = rig();
      sessions.live(SID);
      sessions.in(OTHER_SID, standing);

      const result = await send(connAs("session", SID), OTHER_SID);

      expect(result.delivered).toBe(false);
      expect(result.reason).toBe(outcome);
      expect(problems(result)).toEqual([]);
    });
  }

  test("a session two processes are running takes nothing at all", async () => {
    const { sessions, inbox, send } = rig();
    sessions.live(SID);
    sessions.in(OTHER_SID, "duplicated");

    const refused = await send(connAs("session", SID), OTHER_SID).catch((cause: unknown) => cause);
    expect(refused).toMatchObject({ code: "session_duplicated" });
    // Nothing is held for later: the draft is still with the caller.
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
  });

  test("a full inbox drops the oldest and says so", async () => {
    const { sessions, inbox, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);

    let result!: MessageSendResult;
    for (let n = 0; n <= INBOX_MAX_PER_SID; n += 1) {
      result = await send(connAs("session", SID), OTHER_SID, `n${n}`);
    }

    expect(result.reason).toBe("inbox_full");
    const held = inbox.undelivered(OTHER_SID);
    expect(held).toHaveLength(INBOX_MAX_PER_SID);
    expect(held[0]?.text).toBe("n1");
  });

  test("a message leaving while an arrival is being written decides against what is held now", async () => {
    // The two cross: the line for the arriving message is in flight when the
    // oldest message reaches its session. What is over the limit afterwards is
    // what the session holds then, so nothing is evicted out of a list that is
    // no longer full and no watcher hears that a delivered message was
    // dropped.
    const dir = stateDir();
    const inbox = new Inbox(inboxPath(dir));
    const removed: [string, InboxRemovedReason][] = [];
    inbox.onRemoved((mid, reason) => removed.push([mid, reason]));
    const message = (n: number): InboxMessage => ({
      mid: `${SELF}/${n}`,
      from: SID,
      from_label: SID,
      text: `n${n}`,
      sent_at: Date.now(),
    });
    for (let n = 1; n <= INBOX_MAX_PER_SID; n += 1) await inbox.hold(OTHER_SID, message(n));

    const arriving = inbox.hold(OTHER_SID, message(INBOX_MAX_PER_SID + 1));
    await inbox.delivered(OTHER_SID, [`${SELF}/1`]);
    const outcome = await arriving;

    expect(outcome.evicted).toBe(false);
    const held = inbox.undelivered(OTHER_SID);
    expect(held).toHaveLength(INBOX_MAX_PER_SID);
    expect(held[0]?.text).toBe("n2");
    expect(removed).toEqual([[`${SELF}/1`, "delivered"]]);

    // And a restart replays a session holding no more than the cap.
    const again = new Inbox(inboxPath(dir));
    again.load();
    expect(again.undelivered(OTHER_SID).length).toBeLessThanOrEqual(INBOX_MAX_PER_SID);
  });

  test("throttled is route (a)'s alone, so the flag being off never yields it", async () => {
    const { sessions, send } = rig();
    sessions.live(SID);
    for (const standing of ["alive", "paused", "disappeared"] as const) {
      sessions.in(OTHER_SID, standing);
      const result = await send(connAs("session", SID), OTHER_SID);
      expect(result.reason).not.toBe("throttled");
    }
  });

  test("a session that turns the message away keeps it and is told throttled", async () => {
    const { sessions, inbox, send } = rig({ direct: new StubDirectRoute("refused") });
    sessions.live(SID);
    sessions.live(OTHER_SID);

    const result = await send(connAs("session", SID), OTHER_SID);

    expect(result).toEqual({ delivered: false, reason: "throttled" });
    expect(inbox.undelivered(OTHER_SID)).toHaveLength(1);
  });

  test("route (a) carrying it is the same success route (b) gives", async () => {
    const { sessions, inbox, send } = rig({ direct: new StubDirectRoute("delivered") });
    sessions.live(SID);
    sessions.live(OTHER_SID);

    expect(await send(connAs("session", SID), OTHER_SID)).toEqual({ delivered: true });
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
  });
});

describe("the sessions a message can be addressed to", () => {
  test("a live session nobody is subscribed to is one, not a session not found", async () => {
    // The audit's case: the addressee is running and has never subscribed to
    // anything, which is precisely the session route (a) exists for. Whether
    // this instance can be sent a message about it must not depend on somebody
    // else watching a topic (§5.1 / §6.3).
    const home = mkdtempSync(join(tmpdir(), "ccmsg-live-home-"));
    dirs.push(home);
    const sessionsDir = join(home, "sessions");
    mkdirSync(sessionsDir);
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: OTHER_SID,
        cwd: "/repos/a-repo/main",
        kind: "interactive",
        startedAt: 1_757_000_000_000,
        status: "idle",
      }),
    );
    const domain = new Sessions({
      harness: "claude",
      self: SELF,
      endpoint: SELF_ENDPOINT,
      configHome: home,
      stateDir: stateDir(),
      capabilities: [],
      version: "0.0.1",
      startedAt: 1_757_000_000_000,
      publish: () => "ok",
    });
    const inbox = new Inbox(inboxPath(stateDir()));
    inbox.load();
    const delivery = new Delivery({
      self: SELF,
      sessions: domain,
      inbox,
      direct: new StubDirectRoute("delivered"),
      publish: () => "ok",
      listeners: () => 0,
    });
    const conn = connAs("session", SID);

    const result = await messagingHandlers(
      delivery,
      new Notify({ self: SELF, label: (sid) => sid, publish: () => "ok", duplicated: () => false }),
    )["message.send"]({
      op: "message.send",
      conn,
      args: { op: "message.send", request_id: "1", to: OTHER_SID, text: "are you there" },
      identity: conn.identity.state === "settled" ? conn.identity : undefined,
    });

    expect(domain.watching).toBe(false);
    expect(result).toEqual({ delivered: true });
  });

  test("a session of another config home the gateway saw is not one", async () => {
    // The gateway stands above every config home and its events name nothing
    // but a sid, so it answers for sessions that are not ours. Taking that as
    // liveness would make this instance accept a message for a session whose
    // inbox is somewhere else entirely (§5.1).
    const home = mkdtempSync(join(tmpdir(), "ccmsg-foreign-home-"));
    dirs.push(home);
    mkdirSync(join(home, "sessions"));
    const domain = new Sessions({
      harness: "claude",
      self: SELF,
      endpoint: SELF_ENDPOINT,
      configHome: home,
      stateDir: stateDir(),
      capabilities: [],
      version: "0.0.1",
      startedAt: 1_757_000_000_000,
      publish: () => "ok",
      gateway: { activeAt: () => Date.now() },
    });
    const inbox = new Inbox(inboxPath(stateDir()));
    inbox.load();
    const delivery = new Delivery({
      self: SELF,
      sessions: domain,
      inbox,
      direct: new StubDirectRoute("delivered"),
      publish: () => "ok",
      listeners: () => 0,
    });
    const conn = connAs("session", SID);

    // Nothing greeted and the harness names nobody, so the gateway's word is
    // the only thing that could make OTHER_SID live here.
    expect(domain.row(OTHER_SID)).toBeUndefined();
    expect(domain.peerRows(Date.now())).toEqual([]);
    expect(
      messagingHandlers(
        delivery,
        new Notify({
          self: SELF,
          label: (sid) => sid,
          publish: () => "ok",
          duplicated: () => false,
        }),
      )["message.send"]({
        op: "message.send",
        conn,
        args: { op: "message.send", request_id: "1", to: OTHER_SID, text: "are you there" },
        identity: conn.identity.state === "settled" ? conn.identity : undefined,
      }),
    ).rejects.toThrow("no session");
  });
});

describe("candidates", () => {
  test("are the live sessions of the same repository, and not the addressee", async () => {
    const { sessions, send } = rig();
    sessions.live(SID);
    sessions.live(THIRD_SID, { ws: "feature" });
    sessions.live("aaaabbbb-cccc-4ddd-8eee-ffff00001111", {
      repo_root: "/repos/elsewhere",
      ws: "other",
    });
    sessions.gone(OTHER_SID, "paused");

    const result = await send(connAs("session", SID), OTHER_SID);

    expect(result.reason).toBe("paused");
    expect(result.candidates).toEqual([
      { sid: SID, ws: "main", instance: SELF },
      { sid: THIRD_SID, ws: "feature", instance: SELF },
    ]);
    expect(problems(result)).toEqual([]);
  });

  test("are absent while the addressee is merely not listening yet", async () => {
    const { sessions, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);

    const result = await send(connAs("session", SID), OTHER_SID);

    expect(result.reason).toBe("preparing");
    expect(result.candidates).toBeUndefined();
  });
});

describe("the inbox on disk (§3.6 / §4.3)", () => {
  test("undelivered messages survive a restart, delivered ones do not", async () => {
    const dir = stateDir();
    const first = rig({ dir });
    first.sessions.live(SID);
    first.sessions.live(OTHER_SID);
    const listener = await listening(first.topics, THIRD_SID);
    first.sessions.live(THIRD_SID);
    await first.send(connAs("session", SID), OTHER_SID, "waiting for it");
    await first.send(connAs("session", SID), THIRD_SID, "handed over");
    expect(inboxFrames(listener)).toHaveLength(1);

    // A new instance over the same state directory, which is what a restart is.
    const second = rig({ dir });
    const held = second.inbox.undelivered(OTHER_SID);
    expect(held.map((message) => message.text)).toEqual(["waiting for it"]);
    expect(second.inbox.undelivered(THIRD_SID)).toEqual([]);
  });

  test("a mid is not reissued after a restart", async () => {
    const dir = stateDir();
    const first = rig({ dir });
    first.sessions.live(SID);
    first.sessions.live(OTHER_SID);
    await first.send(connAs("session", SID), OTHER_SID, "one");
    const before = first.inbox.undelivered(OTHER_SID)[0]?.mid;

    const second = rig({ dir });
    second.sessions.live(SID);
    second.sessions.live(OTHER_SID);
    await second.send(connAs("session", SID), OTHER_SID, "two");
    const mids = second.inbox.undelivered(OTHER_SID).map((message) => message.mid);

    expect(mids).toHaveLength(2);
    expect(new Set(mids).size).toBe(2);
    expect(mids[0]).toBe(before as string);
  });

  test("a message past the retention window is gone when it is next asked for", async () => {
    const { sessions, inbox, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);
    await send(connAs("session", SID), OTHER_SID);

    const later = Date.now() + INBOX_RETENTION_MS + 1;
    expect(inbox.undelivered(OTHER_SID, later)).toEqual([]);
  });

  test("a half-written last line costs that line and nothing before it", async () => {
    const dir = stateDir();
    const first = rig({ dir });
    first.sessions.live(SID);
    first.sessions.live(OTHER_SID);
    await first.send(connAs("session", SID), OTHER_SID, "complete");
    await Bun.write(inboxPath(dir), `${await Bun.file(inboxPath(dir)).text()}{"v":"add","si`);

    const second = new Inbox(inboxPath(dir));
    second.load();
    expect(second.undelivered(OTHER_SID).map((message) => message.text)).toEqual(["complete"]);
  });

  test("M4: the state directory gains the inbox and nothing else", async () => {
    const dir = stateDir();
    const { sessions, send } = rig({ dir });
    sessions.live(SID);
    sessions.live(OTHER_SID);
    await send(connAs("session", SID), OTHER_SID);

    // A restart, so a file written only on the way up would show here too.
    rig({ dir });
    expect(readdirSync(dir).sort()).toEqual(["inbox.jsonl"]);
  });
});

describe("what is held is offered again when the session can take it", () => {
  test("route (a) getting through empties what was waiting, oldest first", async () => {
    // Two turned away, then one that gets through: the session is taking
    // messages again, so the two it turned away go now (§4.3).
    const route = new ScriptedDirectRoute([
      "refused",
      "refused",
      "delivered",
      "delivered",
      "delivered",
    ]);
    const { sessions, inbox, send } = rig({ direct: route });
    sessions.live(SID);
    sessions.live(OTHER_SID);
    const sender = connAs("session", SID);

    expect(await send(sender, OTHER_SID, "first")).toEqual({
      delivered: false,
      reason: "throttled",
    });
    expect(await send(sender, OTHER_SID, "second")).toEqual({
      delivered: false,
      reason: "throttled",
    });

    expect(await send(sender, OTHER_SID, "third")).toEqual({ delivered: true });
    expect(route.texts()).toEqual(["first", "second", "third", "first", "second"]);
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
  });

  test("an offer stops where the session turns one away, and the rest stay in order", async () => {
    const route = new ScriptedDirectRoute([
      "refused",
      "refused",
      "delivered",
      "delivered",
      "refused",
    ]);
    const { sessions, inbox, send } = rig({ direct: route });
    sessions.live(SID);
    sessions.live(OTHER_SID);
    const sender = connAs("session", SID);

    await send(sender, OTHER_SID, "first");
    await send(sender, OTHER_SID, "second");
    await send(sender, OTHER_SID, "third");

    // "second" was refused again and "first" is gone, so nothing was offered
    // after the refusal and the one left is still the older of the two.
    expect(route.texts()).toEqual(["first", "second", "third", "first", "second"]);
    expect(inbox.undelivered(OTHER_SID).map((message) => message.text)).toEqual(["second"]);
  });

  test("a subscribe landing mid-offer is handed nothing the offer is carrying", async () => {
    const route = new ScriptedDirectRoute(["refused", "refused", "delivered", "delivered"]);
    const { sessions, topics, inbox, delivery, send } = rig({ direct: route });
    sessions.live(SID);
    sessions.live(OTHER_SID);
    const sender = connAs("session", SID);
    await send(sender, OTHER_SID, "first");
    await send(sender, OTHER_SID, "second");

    let snapshot: InboxMessage[] = [];
    route.during = async () => {
      if (snapshot.length > 0 || route.carried.length !== 3) return;
      snapshot = messagesOf(inboxFrames(await listening(topics, OTHER_SID, true))[0]);
    };
    await delivery.retry();

    // Each message went out once: over route (a) here, and so not in the
    // snapshot the subscribe answered.
    expect(route.texts()).toEqual(["first", "second", "first", "second"]);
    expect(snapshot).toEqual([]);
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
  });

  test("a session that is back is offered what was held while it was gone", async () => {
    // The session is gone, so its socket is too: route (a) does not apply, and
    // the message is held under the reason §4.2 names for that.
    const route = new ScriptedDirectRoute(["unavailable", "delivered"]);
    const { sessions, inbox, delivery, send } = rig({ direct: route });
    sessions.live(SID);
    sessions.gone(OTHER_SID, "disappeared");

    const result = await send(connAs("session", SID), OTHER_SID, "while away");
    expect(result.reason).toBe("disappeared");
    // Nothing is offered to a session that is still gone, so the route was
    // asked once — by the send itself — and not again.
    await delivery.retry();
    expect(route.carried).toHaveLength(1);

    sessions.in(OTHER_SID, "alive");
    await delivery.retry();

    expect(route.texts()).toEqual(["while away", "while away"]);
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
  });
});
