import { describe, expect, test } from "bun:test";
import type { InstanceId } from "@ccmsg/protocol";
import { OpError } from "../src/dispatch/index.ts";
import { Notify } from "../src/messaging/index.ts";
import { Relay } from "../src/mesh/index.ts";
import { FLUSH_PERIOD_MS, QUEUE_LIMIT, Topics } from "../src/topics/index.ts";
import { manualClock } from "./clock.ts";
import { connAs, OTHER_INSTANCE, SELF, SID, TestConn } from "./frames.ts";

/** What the send side of one terminal does with more than it can carry (§6.4).
 *
 * The cases move time by hand rather than waiting it out: what is under test is
 * how many frames leave per period and which ones, and both are decided by the
 * period alone. */

const PEERS = "peers";
const NOTIFY = "notify";

function rig() {
  const time = manualClock();
  const hub = new Topics(SELF, new Set(), undefined, { clock: time.clock });
  const conn = connAs("user");
  hub.attach("peers", { start: () => {}, stop: () => {}, snapshot: () => [] });
  hub.attach("notify", { start: () => {}, stop: () => {}, snapshot: () => [] });
  return { time, hub, conn };
}

/** The frames a subscriber has actually been handed, past the snapshot the
 * subscription itself delivered. */
function delivered(conn: TestConn): Record<string, unknown>[] {
  return conn.topics().filter((frame) => frame["snapshot"] !== true);
}

describe("a value stated faster than it can be read (§6.4)", () => {
  test("a second of restatement leaves one frame per period, and the last value is one of them", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, PEERS);

    // A second of the storm the incident was: one statement per millisecond.
    for (let ms = 0; ms < 1000; ms += 1) {
      hub.publish(PEERS, { peers: [], at: ms });
      time.advance(1);
    }
    time.advance(FLUSH_PERIOD_MS);

    const frames = delivered(conn);
    // One per period, and the one that went out at once because nothing had
    // been sent yet.
    expect(frames.length).toBeLessThanOrEqual(1000 / FLUSH_PERIOD_MS + 1);
    expect(frames.length).toBeGreaterThan(1);
    expect(latest(frames)).toBe(999);
  });

  test("the value that arrives is always the latest, never one already superseded", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, PEERS);

    hub.publish(PEERS, { peers: [], at: 1 });
    time.advance(1);
    hub.publish(PEERS, { peers: [], at: 2 });
    hub.publish(PEERS, { peers: [], at: 3 });
    time.advance(FLUSH_PERIOD_MS);

    expect(delivered(conn).map((frame) => (frame["data"] as { at: number }).at)).toEqual([1, 3]);
  });

  test("one instance's value does not fold onto another's", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, PEERS);
    // The first frame goes out at once, so both of the ones under test are
    // gathered by the same flush.
    hub.publish(PEERS, { peers: [], at: 0 });

    hub.publish(PEERS, { peers: [], from: "self" }, SELF);
    hub.publish(PEERS, { peers: [], from: "other" }, OTHER_INSTANCE);
    time.advance(FLUSH_PERIOD_MS);

    const gathered = delivered(conn).slice(1);
    expect(gathered.map((frame) => frame["instance"])).toEqual([SELF, OTHER_INSTANCE]);
  });

  test("nothing is armed while a terminal is quiet", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, PEERS);

    hub.publish(PEERS, { peers: [], at: 1 });
    expect(time.pending).toBe(0);
    expect(delivered(conn)).toHaveLength(1);
  });
});

describe("what happened, as against what is (§6.4)", () => {
  test("occurrences are all delivered, in the order they were raised", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, NOTIFY);

    for (let n = 0; n < 50; n += 1) hub.publish(NOTIFY, { n });
    time.advance(FLUSH_PERIOD_MS);

    expect(delivered(conn).map((frame) => (frame["data"] as { n: number }).n)).toEqual(
      Array.from({ length: 50 }, (_, n) => n),
    );
  });

  test("occurrences keep their order among the values folded beside them", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, NOTIFY);
    hub.subscribe(conn, PEERS);
    hub.publish(NOTIFY, { n: 0 });

    hub.publish(PEERS, { peers: [], at: 1 });
    hub.publish(NOTIFY, { n: 1 });
    hub.publish(PEERS, { peers: [], at: 2 });
    hub.publish(NOTIFY, { n: 2 });
    time.advance(FLUSH_PERIOD_MS);

    // The value keeps the place its first statement took, carrying the latest
    // of what was said there.
    expect(delivered(conn).slice(1).map(topicOf)).toEqual([PEERS, NOTIFY, NOTIFY]);
    expect(delivered(conn).slice(1)[0]?.["data"]).toEqual({ peers: [], at: 2 });
  });

  test("past the limit the frame is refused, and the queue below it is untouched", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, NOTIFY);
    hub.publish(NOTIFY, { n: -1 });

    const outcomes = new Set<string>();
    for (let n = 0; n < QUEUE_LIMIT + 10; n += 1) outcomes.add(hub.publish(NOTIFY, { n }));
    expect([...outcomes]).toEqual(["ok", "rate_limited"]);

    time.advance(FLUSH_PERIOD_MS);
    const carried = delivered(conn).slice(1);
    expect(carried).toHaveLength(QUEUE_LIMIT);
    expect((dataOf(carried[carried.length - 1]) as { n: number }).n).toBe(QUEUE_LIMIT - 1);
  });

  test("a flush makes room again", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, NOTIFY);
    for (let n = 0; n < QUEUE_LIMIT + 1; n += 1) hub.publish(NOTIFY, { n });
    time.advance(FLUSH_PERIOD_MS);

    expect(hub.publish(NOTIFY, { n: "after" })).toBe("ok");
  });

  test("the op that raised the notification is the one told", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, NOTIFY);
    const notify = new Notify({
      self: SELF,
      label: (sid) => sid,
      publish: (topic, data, instance) => hub.publish(topic, data, instance),
    });
    const input = {
      op: "notify_send" as const,
      conn,
      args: { op: "notify_send", request_id: "1", sid: SID, text: "look" },
      identity: { state: "settled" as const, role: "user" as const },
    };

    // Up to the limit the op answers; past it the caller hears that the
    // notification was not taken rather than it going nowhere.
    // The first goes out at once, so the queue fills on the ones after it.
    for (let n = 0; n < QUEUE_LIMIT + 1; n += 1) notify.send(input);
    expect(() => notify.send(input)).toThrow(OpError);

    time.advance(FLUSH_PERIOD_MS);
    expect(delivered(conn)).toHaveLength(QUEUE_LIMIT + 1);
  });
});

describe("a relayed value goes through the same layer (§7.4, §6.4)", () => {
  test("a peer restating itself leaves one frame per period, carrying its latest", () => {
    const { time, hub, conn } = rig();
    hub.subscribe(conn, PEERS);
    const relay = new Relay({
      publish: (topic, data, instance) => {
        hub.publish(topic, data, instance);
      },
    });

    for (let n = 0; n < 200; n += 1) {
      relay.accept(OTHER_INSTANCE as InstanceId, PEERS, { peers: [], at: n });
      time.advance(1);
    }
    time.advance(FLUSH_PERIOD_MS);

    const frames = delivered(conn);
    expect(frames.length).toBeLessThanOrEqual(200 / FLUSH_PERIOD_MS + 1);
    expect(frames.every((frame) => frame["instance"] === OTHER_INSTANCE)).toBe(true);
    expect(latest(frames)).toBe(199);
  });
});

/** The `at` the last frame carries: which statement of the value it is. */
function latest(frames: Record<string, unknown>[]): number {
  return (dataOf(frames[frames.length - 1]) as { at: number }).at;
}

function dataOf(frame: Record<string, unknown> | undefined): unknown {
  if (frame === undefined) throw new Error("no frame was delivered");
  return frame["data"];
}

function topicOf(frame: Record<string, unknown>): string {
  return frame["topic"] as string;
}
