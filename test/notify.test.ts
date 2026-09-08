import { describe, expect, test } from "bun:test";
import {
  type Notification,
  OP_SCHEMAS,
  type SayPostResult,
  type Sid,
  TOPIC_SCHEMAS,
  validationErrors,
} from "@ccmsg/protocol";
import { OpError } from "../src/dispatch/index.ts";
import { type Delivery, messagingHandlers, Notify } from "../src/messaging/index.ts";
import { Topics } from "../src/topics/index.ts";
import { connAs, OTHER_SID, SELF, SID, TestConn } from "./frames.ts";

/** The labels the instance resolves, written out rather than driven through the
 * sessions domain: what a test here fixes is that the label comes from the
 * instance and not from the caller's arguments. */
const LABELS: Record<string, string> = { [SID]: "a-repo/main", [OTHER_SID]: "a-repo/side" };

interface Rig {
  topics: Topics;
  notify: Notify;
  send: (from: TestConn, args: Record<string, unknown>) => void;
  post: (from: TestConn, text: string) => SayPostResult;
  markRead: (sid?: Sid) => void;
}

function rig(): Rig {
  const topics = new Topics(SELF, new Set());
  const notify = new Notify({
    self: SELF,
    label: (sid) => LABELS[sid] ?? sid,
    publish: (topic, data, instance) => {
      topics.publish(topic, data, instance);
    },
  });
  topics.attach("notify", notify);
  // Delivery refuses rather than being absent: none of the three ops here goes
  // near it, and a test that reached it would fail saying so.
  const ops = messagingHandlers(
    {
      send: () => {
        throw new Error("delivery was reached");
      },
    } as unknown as Delivery,
    notify,
  );
  const input = (op: string, conn: TestConn, args: Record<string, unknown>) => ({
    op: op as never,
    conn,
    args: { op, request_id: "1", ...args },
    identity: conn.identity.state === "settled" ? conn.identity : undefined,
  });
  return {
    topics,
    notify,
    send: (from, args) => {
      ops.notify_send(input("notify_send", from, args));
    },
    post: (from, text) => ops.say_post(input("say_post", from, { text })) as SayPostResult,
    markRead: (sid) => {
      ops.say_mark_read(input("say_mark_read", connAs("user"), sid === undefined ? {} : { sid }));
    },
  };
}

/** The notifications one connection was pushed, unwrapped from their frames. */
function received(conn: TestConn): Notification[] {
  return conn.topics().map((frame) => frame["data"] as Notification);
}

describe("notify_send reaches whoever is watching", () => {
  test("the notification names the session and the label the instance resolved", () => {
    const { topics, send } = rig();
    const watcher = connAs("user");
    topics.subscribe(watcher, "notify");
    watcher.flush();

    send(connAs("session", SID), { text: "見てほしい" });

    expect(received(watcher)).toEqual([
      { sid: SID, sid_label: "a-repo/main", text: "見てほしい", sent_at: expect.any(Number) },
    ]);
  });

  test("`sid` names the session it is about, and the caller is meant without it", () => {
    const { topics, send } = rig();
    const watcher = connAs("user");
    topics.subscribe(watcher, "notify");
    watcher.flush();

    send(connAs("session", SID), { text: "自分のこと" });
    send(connAs("session", SID), { text: "隣のこと", sid: OTHER_SID });

    expect(received(watcher).map((one) => [one.sid, one.sid_label])).toEqual([
      [SID, "a-repo/main"],
      [OTHER_SID, "a-repo/side"],
    ]);
  });

  test("a person naming no session has named nobody for it to be about", () => {
    const { send } = rig();
    const person = new TestConn({ state: "settled", role: "user" });
    expect(() => send(person, { text: "誰の話か分からない" })).toThrow(OpError);
  });

  test("nothing is held: a connection that subscribes after it gets no snapshot", () => {
    const { topics, send } = rig();
    const early = connAs("user");
    topics.subscribe(early, "notify");
    early.flush();
    send(connAs("session", SID), { text: "一度きり" });

    const late = new TestConn({ state: "settled", role: "user" });
    topics.subscribe(late, "notify");
    late.flush();

    expect(received(early)).toHaveLength(1);
    expect(received(late)).toEqual([]);
  });

  test("the same line twice is two occurrences, not one repeated value", () => {
    const { topics, send } = rig();
    const watcher = connAs("user");
    topics.subscribe(watcher, "notify");
    watcher.flush();

    send(connAs("session", SID), { text: "同じ" });
    send(connAs("session", SID), { text: "同じ" });

    expect(received(watcher).map((one) => one.text)).toEqual(["同じ", "同じ"]);
  });
});

describe("say_post says who spoke", () => {
  test("the text reaches the watchers and the session is left unread", () => {
    const { topics, notify, post } = rig();
    const watcher = connAs("user");
    topics.subscribe(watcher, "notify");
    watcher.flush();

    const result = post(connAs("session", SID), "喋りました");

    expect(result.posted_at).toEqual(expect.any(Number));
    expect(received(watcher)).toEqual([
      { sid: SID, sid_label: "a-repo/main", text: "喋りました", sent_at: result.posted_at },
    ]);
    expect(notify.unread()).toEqual([SID]);
  });

  test("say_mark_read clears the named session, and every one when none is named", () => {
    const { notify, post, markRead } = rig();
    post(connAs("session", SID), "こちら");
    post(connAs("session", OTHER_SID), "あちら");

    markRead(SID);
    expect(notify.unread()).toEqual([OTHER_SID]);

    post(connAs("session", SID), "また");
    markRead();
    expect(notify.unread()).toEqual([]);
  });

  test("one session speaking twice is unread once", () => {
    const { notify, post } = rig();
    post(connAs("session", SID), "一回目");
    post(connAs("session", SID), "二回目");
    expect(notify.unread()).toEqual([SID]);
  });
});

describe("what goes on the wire is the contract's own shape", () => {
  test("every frame and every result passes the contract's validator", () => {
    const { topics, send, post } = rig();
    const watcher = connAs("user");
    topics.subscribe(watcher, "notify");
    watcher.flush();

    send(connAs("session", SID), { text: "通知" });
    send(connAs("session", SID), { text: "別のセッションのこと", sid: OTHER_SID });
    const posted = post(connAs("session", OTHER_SID), "発話");

    expect(watcher.topics()).toHaveLength(3);
    for (const frame of watcher.topics()) {
      expect(validationErrors(TOPIC_SCHEMAS.notify, frame)).toEqual([]);
    }
    expect(
      validationErrors(OP_SCHEMAS.say_post.response, { ok: true, request_id: "1", ...posted }),
    ).toEqual([]);
  });
});
