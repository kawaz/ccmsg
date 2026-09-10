import { describe, expect, test } from "bun:test";
import {
  type Capability,
  type Notification,
  type Role,
  TOPIC_ATTRIBUTES,
  TOPIC_SCHEMAS,
  topicGranularity,
  type TopicKind,
  validationErrors,
} from "@ccmsg/protocol";
import { KV_FRAME, NOTIFY_FRAME } from "@ccmsg/protocol/fixtures";
import { Glob } from "bun";
import { dispatch, type DispatchDeps, type Handlers } from "../src/dispatch/index.ts";
import { topicHandlers, type TopicValue, Topics } from "../src/topics/index.ts";
import { connAs, frameFor, OTHER_INSTANCE, OTHER_SID, SELF, SID, TestConn } from "./frames.ts";
import { unthrottled } from "./clock.ts";

const NOTIFICATION = NOTIFY_FRAME.data as Notification;

/** A topic that holds a value, and one payload the contract accepts for it.
 * The cases about snapshots and suppression need a topic there is something to
 * snapshot and repeat — which `notify`, alone among the topics here, is not. */
const KV = "kv:ui";
const ENTRIES = KV_FRAME.data;

const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(["llm_events", "llm_status"]);

function topics(capabilities: ReadonlySet<Capability> = ALL_CAPABILITIES): Topics {
  return new Topics(SELF, capabilities, undefined, unthrottled());
}

/** Stands in for whoever owns a topic's values (§3.3): it states the current
 * value when asked, and records the subscription driving it. */
function owner(hub: Topics, kind: TopicKind, current: readonly TopicValue[] = []) {
  const started: string[] = [];
  const stopped: string[] = [];
  const state = { current, asked: [] as string[] };
  hub.attach(kind, {
    start: (topic) => started.push(topic),
    stop: (topic) => stopped.push(topic),
    snapshot: (topic) => {
      state.asked.push(topic);
      return state.current;
    },
  });
  return { started, stopped, state };
}

/** A role the topic table allows for a kind, read from the table. */
function allowedRole(kind: TopicKind) {
  return TOPIC_ATTRIBUTES[kind].roles[0];
}

describe("the subscription is the whole of what a topic holds (§6.1)", () => {
  test("subscribing hands over the current value once, marked as a snapshot", () => {
    const hub = topics();
    owner(hub, "kv", [{ instance: SELF, data: ENTRIES }]);
    const conn = connAs("user");

    expect(hub.subscribe(conn, KV)).toBe("ok");
    // Queued behind the reply, as the driver releases it.
    expect(conn.topics()).toEqual([]);
    conn.flush();

    expect(conn.topics()).toEqual([
      { ev: "topic", topic: KV, snapshot: true, instance: SELF, data: ENTRIES },
    ]);
  });

  test("the frames it produces are the frames the contract describes", () => {
    const hub = topics();
    owner(hub, "kv", [{ instance: SELF, data: ENTRIES }]);
    const conn = connAs("user");
    hub.subscribe(conn, KV);
    hub.publish(KV, ENTRIES);
    const second = connAs("user");
    hub.subscribe(second, KV);
    second.flush();

    for (const frame of [...conn.topics(), ...second.topics()]) {
      expect(validationErrors(TOPIC_SCHEMAS.kv, frame)).toEqual([]);
    }
    // One change to the subscriber that was already there, one snapshot to the
    // one that arrived after: the same shape reached both.
    expect(conn.topics()[0]?.["snapshot"]).toBeUndefined();
    expect(second.topics()[0]?.["snapshot"]).toBe(true);
  });

  test("a change reaches every subscriber of that topic and no other", () => {
    const hub = topics();
    const here = connAs("user");
    const elsewhere = connAs("user");
    hub.subscribe(here, "notify");
    hub.subscribe(elsewhere, "peers");

    hub.publish("notify", NOTIFICATION);

    expect(here.topics()).toHaveLength(1);
    expect(elsewhere.topics()).toHaveLength(0);
  });
});

/** A topic whose frames replace the value they carry, and one payload the
 * contract accepts for it. Suppression is about those: a repeated whole value
 * leaves the subscriber holding what it already holds. */
const PEERS = "peers";
const PEER_LIST = { peers: [], last_live: [] };

/** Which topics the rule covers, read off the contract rather than listed
 * here: the granularity is what decides, so a topic added to the contract
 * joins whichever of these two cases its granularity puts it in. */
const REPLACING = (kind: TopicKind) =>
  topicGranularity(kind) === "whole" || topicGranularity(kind) === "per_instance_whole";

describe("suppression is one implementation, and it is every topic's (M5)", () => {
  test("the same value twice is pushed once", () => {
    const hub = topics();
    const conn = connAs("user");
    hub.subscribe(conn, PEERS);

    hub.publish(PEERS, PEER_LIST);
    hub.publish(PEERS, { ...PEER_LIST });

    expect(conn.topics()).toHaveLength(1);
  });

  test("a value that differs is pushed, and repeating it is suppressed again", () => {
    const hub = topics();
    const conn = connAs("user");
    hub.subscribe(conn, PEERS);

    hub.publish(PEERS, { count: 1 });
    hub.publish(PEERS, { count: 2 });
    hub.publish(PEERS, { count: 2 });

    expect(conn.topics().map((frame) => frame["data"])).toEqual([{ count: 1 }, { count: 2 }]);
  });

  test("every topic whose frames replace the value is suppressed, not a chosen few", () => {
    for (const kind of (Object.keys(TOPIC_ATTRIBUTES) as TopicKind[]).filter(REPLACING)) {
      const hub = topics();
      const conn = connAs(allowedRole(kind));
      const name = topicName(kind);
      expect([kind, hub.subscribe(conn, name)]).toEqual([kind, "ok"]);
      hub.publish(name, { same: true });
      hub.publish(name, { same: true });
      expect([kind, conn.topics().length]).toEqual([kind, 1]);
    }
  });

  test("a topic whose frames are deltas repeats them, because a repeat is a second one", () => {
    // The same message offered to a session twice is two offers, and the
    // second is the one that reaches a session that was not listening for the
    // first. Suppressing it would drop the delivery, not a duplicate.
    for (const kind of (Object.keys(TOPIC_ATTRIBUTES) as TopicKind[]).filter(
      (candidate) => !REPLACING(candidate) && topicGranularity(candidate) !== "event",
    )) {
      const hub = topics();
      const conn = connAs(allowedRole(kind));
      const name = topicName(kind);
      expect([kind, hub.subscribe(conn, name)]).toEqual([kind, "ok"]);
      hub.publish(name, { same: true });
      hub.publish(name, { same: true });
      expect([kind, conn.topics().length]).toEqual([kind, 2]);
    }
  });

  test("one instance repeating itself does not hide another instance's value", () => {
    const hub = topics();
    const conn = connAs("user");
    hub.subscribe(conn, "peers");

    hub.publish("peers", { count: 1 }, SELF);
    hub.publish("peers", { count: 1 }, OTHER_INSTANCE);
    hub.publish("peers", { count: 1 }, SELF);

    // The two instances' whole values share the topic name without colliding
    // (§6.2), so the third publish is a repeat of the first and nothing else.
    expect(conn.topics().map((frame) => frame["instance"])).toEqual([SELF, OTHER_INSTANCE]);
  });

  test("a later subscriber is handed every instance's share as a snapshot", () => {
    const hub = topics();
    owner(hub, "peers", [
      { instance: SELF, data: { count: 1 } },
      { instance: OTHER_INSTANCE, data: { count: 2 } },
    ]);
    const first = connAs("user");
    hub.subscribe(first, "peers");
    hub.publish("peers", { count: 1 }, SELF);
    hub.publish("peers", { count: 2 }, OTHER_INSTANCE);

    const later = connAs("user");
    hub.subscribe(later, "peers");
    later.flush();

    expect(later.topics()).toEqual([
      { ev: "topic", topic: "peers", snapshot: true, instance: SELF, data: { count: 1 } },
      {
        ev: "topic",
        topic: "peers",
        snapshot: true,
        instance: OTHER_INSTANCE,
        data: { count: 2 },
      },
    ]);
  });
});

describe("the current value comes from whoever owns it (§3.3)", () => {
  test("a topic whose frames are elements snapshots the whole of them", () => {
    const hub = topics();
    const whole = { entries: [{ key: "a" }, { key: "b" }] };
    owner(hub, "kv", [{ instance: SELF, data: whole }]);
    const conn = connAs("user");
    hub.subscribe(conn, KV);
    // One element went past as a change; the current value is every element,
    // which is a thing only the owner can state.
    hub.publish(KV, { entries: [{ key: "b" }] });

    const later = connAs("user");
    hub.subscribe(later, KV);
    later.flush();
    expect(later.topics()).toEqual([
      { ev: "topic", topic: KV, snapshot: true, instance: SELF, data: whole },
    ]);
  });

  test("the owner is asked at each subscription, not once", () => {
    const hub = topics();
    const { state } = owner(hub, "kv", [{ instance: SELF, data: ENTRIES }]);
    hub.subscribe(connAs("user"), KV);
    hub.subscribe(connAs("user"), KV);
    expect(state.asked).toEqual([KV, KV]);
  });

  test("with no owner attached the subscription still stands, with no snapshot", () => {
    // Where a topic's values are not implemented yet, subscribing is still
    // what a subscriber does: it hears whatever is published from then on.
    const hub = topics();
    const conn = connAs("user");
    expect(hub.subscribe(conn, KV)).toBe("ok");
    conn.flush();
    expect(conn.topics()).toEqual([]);

    hub.publish(KV, ENTRIES);
    expect(conn.topics()).toHaveLength(1);
  });
});

describe("a topic with nothing to hold (§6.2, granularity event)", () => {
  test("the same notification twice arrives twice", () => {
    const hub = topics();
    const conn = connAs("user");
    hub.subscribe(conn, "notify");

    hub.publish("notify", NOTIFICATION);
    hub.publish("notify", { ...NOTIFICATION });

    // A notification matters when it happens, so "the same as last time" is
    // not a reason to drop one. Suppression needs a held value, and there is
    // none here — which is why this needs no code of its own.
    expect(conn.topics()).toHaveLength(2);
  });

  test("a later subscriber gets no snapshot, only what happens next", () => {
    const hub = topics();
    // Its owner has no value to state, which is what `event` means.
    owner(hub, "notify");
    hub.publish("notify", NOTIFICATION);

    const conn = connAs("user");
    hub.subscribe(conn, "notify");
    conn.flush();
    expect(conn.topics()).toEqual([]);

    hub.publish("notify", NOTIFICATION);
    expect(conn.topics()).toEqual([
      { ev: "topic", topic: "notify", instance: SELF, data: NOTIFICATION },
    ]);
  });

  test("its frames are still the frames the contract describes", () => {
    const hub = topics();
    const conn = connAs("user");
    hub.subscribe(conn, "notify");
    hub.publish("notify", NOTIFICATION);
    for (const frame of conn.topics()) {
      expect(validationErrors(TOPIC_SCHEMAS.notify, frame)).toEqual([]);
    }
  });
});

describe("a subscription ends with its connection (§6.3)", () => {
  test("closing the connection drops the subscription and what follows it", () => {
    const hub = topics();
    const conn = connAs("user");
    hub.subscribe(conn, KV);
    expect(hub.subscriberCount(KV)).toBe(1);

    conn.close();

    expect(hub.subscriberCount(KV)).toBe(0);
    hub.publish(KV, ENTRIES);
    expect(conn.topics()).toHaveLength(0);
  });

  test("one close listener per connection, however often it subscribes", () => {
    // A client moving between views subscribes and unsubscribes for as long as
    // it is connected. A listener registered per subscription is held until the
    // connection closes, so the connection accrues one for every move it makes.
    const hub = topics();
    const conn = connAs("user");

    for (let round = 0; round < 50; round++) {
      hub.subscribe(conn, KV);
      hub.unsubscribe(conn, KV);
    }
    hub.subscribe(conn, `transcript:${SID}`);

    expect(conn.listenerCount).toBe(1);
    // And the one listener still releases everything the connection holds.
    hub.subscribe(conn, KV);
    conn.close();
    expect(hub.subscriberCount(KV)).toBe(0);
    expect(hub.subscriberCount(`transcript:${SID}`)).toBe(0);
  });

  test("unsubscribing stops the frames, and repeating it changes nothing", () => {
    const hub = topics();
    const conn = connAs("user");
    hub.subscribe(conn, KV);

    expect(hub.unsubscribe(conn, KV)).toBe("ok");
    expect(hub.unsubscribe(conn, KV)).toBe("ok");
    hub.publish(KV, ENTRIES);

    expect(conn.topics()).toHaveLength(0);
  });
});

describe("subscription is what drives the resource behind a topic (§6.3)", () => {
  function counting() {
    const hub = topics();
    return { hub, ...owner(hub, "transcript") };
  }

  const TRANSCRIPT = `transcript:${SID}`;

  test("the first subscriber starts it and the last one to leave stops it", () => {
    const { hub, started, stopped } = counting();
    const first = connAs("user");
    const second = connAs("user");

    hub.subscribe(first, TRANSCRIPT);
    hub.subscribe(second, TRANSCRIPT);
    expect([started, stopped]).toEqual([[TRANSCRIPT], []]);

    hub.unsubscribe(first, TRANSCRIPT);
    expect(stopped).toEqual([]);
    second.close();
    expect(stopped).toEqual([TRANSCRIPT]);
  });

  test("the resource is per topic name, not per kind", () => {
    const { hub, started } = counting();
    hub.subscribe(connAs("user"), TRANSCRIPT);
    hub.subscribe(connAs("user"), `transcript:${OTHER_SID}`);
    expect(started).toHaveLength(2);
  });

  test("the first frame after it starts again is not taken for a repeat", () => {
    const { hub } = counting();
    const first = connAs("user");
    hub.subscribe(first, TRANSCRIPT);
    hub.publish(TRANSCRIPT, { at: 1 });
    first.close();

    // What was sent before the resource stopped is no longer something the
    // next frame can repeat, so suppression does not reach across the gap.
    const later = connAs("user");
    hub.subscribe(later, TRANSCRIPT);
    hub.publish(TRANSCRIPT, { at: 1 });
    expect(later.topics()).toHaveLength(1);
  });
});

describe("who may hear a topic (§11.2)", () => {
  test("a user-only topic does not reach a session", () => {
    const hub = topics();
    const session = connAs("session");
    expect(hub.subscribe(session, "agents")).toBe("forbidden");

    hub.publish("agents", { agents: [] });
    expect(session.topics()).toEqual([]);
  });

  test("every topic refuses the roles its row leaves out, swept over the table", () => {
    for (const kind of Object.keys(TOPIC_ATTRIBUTES) as TopicKind[]) {
      const roles: readonly Role[] = TOPIC_ATTRIBUTES[kind].roles;
      const outside = (["session", "user"] as const).filter((role) => !roles.includes(role));
      for (const role of outside) {
        const hub = topics();
        expect([kind, role, hub.subscribe(connAs(role), topicName(kind))]).toEqual([
          kind,
          role,
          "forbidden",
        ]);
      }
    }
  });

  test("a topic naming a capability the instance lacks is refused", () => {
    const hub = topics(new Set<Capability>());
    expect(hub.subscribe(connAs("user"), "llm_status")).toBe("capability_unavailable");
    expect(topics().subscribe(connAs("user"), "llm_status")).toBe("ok");
  });

  test("a name outside the contract is unknown", () => {
    const hub = topics();
    expect(hub.subscribe(connAs("user"), "no_such_topic")).toBe("topic_unknown");
    expect(hub.unsubscribe(connAs("user"), "no_such_topic")).toBe("topic_unknown");
  });

  test("an anonymous connection subscribes to nothing", () => {
    expect(topics().subscribe(new TestConn(), "notify")).toBe("forbidden");
  });
});

describe("the ops reach the mechanism through dispatch", () => {
  function deps(hub: Topics): DispatchDeps {
    const handlers = {
      ...topicHandlers(hub),
    } as unknown as Handlers;
    return {
      self: SELF,
      capabilities: ALL_CAPABILITIES,
      resolveInstance: () => undefined,
      handlers,
    };
  }

  test("the reply acknowledges, and the snapshot follows it", async () => {
    const hub = topics();
    owner(hub, "peers", [{ instance: SELF, data: { count: 1 } }]);
    const conn = connAs("user");

    const result = await dispatch(frameFor("topic_subscribe", { topic: "peers" }), conn, deps(hub));

    expect(result).toEqual({
      kind: "reply",
      response: { ok: true, request_id: "1", topic: "peers" },
    });
    // The driver sends the reply and then releases what the handler queued.
    conn.flush();
    expect(conn.topics()).toEqual([
      { ev: "topic", topic: "peers", snapshot: true, instance: SELF, data: { count: 1 } },
    ]);
  });

  test("unsubscribing through the op stops the frames", async () => {
    const hub = topics();
    const conn = connAs("user");
    await dispatch(frameFor("topic_subscribe", { topic: "peers" }), conn, deps(hub));
    await dispatch(frameFor("topic_unsubscribe", { topic: "peers" }), conn, deps(hub));

    hub.publish("peers", { count: 1 });
    conn.flush();
    expect(conn.topics()).toEqual([]);
  });

  test("a refusal from the mechanism becomes the contract's error", async () => {
    const hub = topics();
    const result = await dispatch(
      frameFor("topic_subscribe", { topic: "agents" }),
      connAs("session"),
      deps(hub),
    );
    expect(result.kind === "error" && result.response.error.code).toBe("forbidden");
  });

  test("a name outside the contract never reaches the mechanism", async () => {
    // The op's schema is built from the same topic lists the mechanism reads,
    // so dispatch refuses an unknown name at step 2. `topic_unknown` is what
    // answers a name that passes the schema and no longer exists, which is why
    // the mechanism keeps the outcome even though this route cannot show it.
    const result = await dispatch(
      { op: "topic_subscribe", request_id: "1", topic: "no_such_topic" },
      connAs("user"),
      deps(topics()),
    );
    expect(result.kind === "error" && result.response.error.code).toBe("invalid_args");
  });
});

/** M5: how a frame folds is a property of the topic, so it is read from the
 * contract and not restated here. The suppression sweep above covers the
 * behaviour; this covers the shape, which behaviour cannot see — a local table
 * that happens to agree with the contract passes every sweep and still is the
 * second place the fact lives. */
describe("the granularity is the contract's (M5)", () => {
  const SRC = new URL("../src/", import.meta.url).pathname;

  test("no module states a granularity of its own", () => {
    const files = [...new Glob("**/*.ts").scanSync(SRC)];
    // The scan reaching the topics module is what makes an empty result mean
    // "none found" rather than "nothing looked at".
    expect(files).toContain("topics/topics.ts");
    expect(files.filter((path) => path.includes("granularity"))).toEqual([]);
  });

  test("the suppression reads the contract", async () => {
    const source = await Bun.file(`${SRC}topics/topics.ts`).text();
    expect(source).toContain("topicGranularity");
  });
});

/** A subscribable name for a kind: the parameterised ones need their parameter. */
function topicName(kind: TopicKind): string {
  if (kind === "kv") return `${kind}:ui`;
  if (kind === "session_status" || kind === "transcript") return `${kind}:${SID}`;
  return kind;
}
