import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOX_MAX_PER_SID,
  INBOX_RETENTION_MS,
  type InboxMessage,
  type LastLiveSession,
  type MessageSendResult,
  OP_SCHEMAS,
  type PeerInfo,
  SessionState as SessionStateSchema,
  type SessionState,
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
import { connAs, OTHER_SID, SELF, SID, TestConn } from "./frames.ts";

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

/** The sessions domain as delivery sees it: a classification per sid and the
 * two lists. Written out rather than driven through `Sessions`, so a test that
 * fixes what a reason is derived from cannot be satisfied by arranging the
 * inputs some other way. */
class FakeSessions {
  readonly states = new Map<Sid, SessionState>();
  readonly connected: PeerInfo[] = [];
  readonly lastLive: LastLiveSession[] = [];

  classify(sid: Sid): SessionState | undefined {
    return this.states.get(sid);
  }

  peers() {
    return { peers: this.connected, last_live: this.lastLive };
  }

  live(sid: Sid, over: Partial<PeerInfo> = {}): void {
    this.states.set(sid, "live");
    this.connected.push({
      sid,
      instance: SELF,
      repo: "a-repo",
      ws: "main",
      cwd: `${REPO_ROOT}/main`,
      repo_root: REPO_ROOT,
      protocol_version: 2,
      ...over,
    });
  }

  gone(sid: Sid, state: "paused" | "disappeared", repoRoot = REPO_ROOT): void {
    this.states.set(sid, state);
    this.lastLive.push({
      sid,
      instance: SELF,
      repo: "a-repo",
      ws: "main",
      cwd: `${repoRoot}/main`,
      repo_root: repoRoot,
      last_seen_at: 1_757_000_000_000,
    });
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
  during: ((message: InboxMessage) => void) | undefined;

  constructor(private readonly outcomes: DirectOutcome[]) {}

  async send(_sid: Sid, message: InboxMessage): Promise<DirectOutcome> {
    this.carried.push(message);
    // A real send gives up the turn on a socket; this gives it up on nothing,
    // which is what lets a subscribe land in the middle of an offer.
    await Promise.resolve();
    this.during?.(message);
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

function rig(over: { direct?: DirectRoute; dir?: string } = {}): Rig {
  const dir = over.dir ?? stateDir();
  const sessions = new FakeSessions();
  const topics = new Topics(SELF, new Set());
  const inbox = new Inbox(inboxPath(dir));
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
  });
  topics.attach("inbox", delivery);
  topics.attach("notify", notify);
  const send = async (from: TestConn, to: Sid, text = "hi") => {
    const result = await messagingHandlers(delivery, notify).message_send({
      op: "message_send",
      conn: from,
      args: { op: "message_send", request_id: "1", to, text },
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
function listening(topics: Topics, sid: Sid, keepSnapshot = false): TestConn {
  const conn = connAs("session", sid);
  expect(topics.subscribe(conn, "inbox")).toBe("ok");
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
  return validationErrors(OP_SCHEMAS.message_send.response, {
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
    const recipient = listening(topics, OTHER_SID);

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
    const recipient = listening(topics, OTHER_SID);

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
    const recipient = listening(topics, OTHER_SID);
    const bystander = listening(topics, THIRD_SID);

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

    const recipient = listening(topics, OTHER_SID, true);
    const frames = inboxFrames(recipient);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.["snapshot"]).toBe(true);
    expect(messagesOf(frames[0])[0]?.text).toBe("held");
    // Delivered is delivered: a second subscriber does not receive it again.
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
    expect(messagesOf(inboxFrames(listening(topics, OTHER_SID, true))[0])).toEqual([]);
  });

  test("a person watching the topic is handed nobody's messages", async () => {
    const { sessions, topics, send } = rig();
    sessions.live(SID);
    sessions.live(OTHER_SID);
    const watcher = connAs("user", OTHER_SID);
    watcher.identity = { state: "settled", role: "user" };
    expect(topics.subscribe(watcher, "inbox")).toBe("ok");
    watcher.flush();

    const result = await send(connAs("session", SID), OTHER_SID);

    expect(result.delivered).toBe(false);
    expect(inboxFrames(watcher)).toEqual([]);
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
  const REASONS: [SessionState, string][] = [
    ["live", "preparing"],
    ["live_unmanaged", "preparing"],
    ["waiting", "preparing"],
    ["paused", "paused"],
    ["disappeared", "disappeared"],
  ];

  for (const [state, reason] of REASONS) {
    test(`${state} is ${reason}`, async () => {
      const { sessions, send } = rig();
      sessions.live(SID);
      sessions.states.set(OTHER_SID, state);

      const result = await send(connAs("session", SID), OTHER_SID);

      expect(result.delivered).toBe(false);
      expect(result.reason).toBe(reason as MessageSendResult["reason"]);
      expect(problems(result)).toEqual([]);
    });
  }

  test("the table covers every state the contract defines", () => {
    // Read out of the contract, so a state added to it lands here rather than
    // falling through the reason table above unnoticed.
    const declared = (SessionStateSchema.anyOf as { const: SessionState }[]).map(
      (branch) => branch.const,
    );
    expect(new Set(REASONS.map(([state]) => state))).toEqual(new Set(declared));
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

  test("throttled is route (a)'s alone, so the flag being off never yields it", async () => {
    const { sessions, send } = rig();
    sessions.live(SID);
    for (const [state] of [
      ["live"],
      ["live_unmanaged"],
      ["waiting"],
      ["paused"],
      ["disappeared"],
    ] as [SessionState][]) {
      sessions.states.set(OTHER_SID, state);
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
      self: SELF,
      configHome: home,
      stateDir: stateDir(),
      capabilities: [],
      version: "0.0.1",
      startedAt: 1_757_000_000_000,
      publish: () => {},
    });
    const inbox = new Inbox(inboxPath(stateDir()));
    inbox.load();
    const delivery = new Delivery({
      self: SELF,
      sessions: domain,
      inbox,
      direct: new StubDirectRoute("delivered"),
      publish: () => {},
      listeners: () => 0,
    });
    const conn = connAs("session", SID);

    const result = await messagingHandlers(
      delivery,
      new Notify({ self: SELF, label: (sid) => sid, publish: () => {} }),
    ).message_send({
      op: "message_send",
      conn,
      args: { op: "message_send", request_id: "1", to: OTHER_SID, text: "are you there" },
      identity: conn.identity.state === "settled" ? conn.identity : undefined,
    });

    expect(domain.watching).toBe(false);
    expect(result).toEqual({ delivered: true });
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
    const listener = listening(first.topics, THIRD_SID);
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
    route.during = () => {
      if (snapshot.length > 0 || route.carried.length !== 3) return;
      snapshot = messagesOf(inboxFrames(listening(topics, OTHER_SID, true))[0]);
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

    sessions.states.set(OTHER_SID, "live");
    await delivery.retry();

    expect(route.texts()).toEqual(["while away", "while away"]);
    expect(inbox.undelivered(OTHER_SID)).toEqual([]);
  });
});
