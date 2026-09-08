import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type KvEntry,
  OP_SCHEMAS,
  PROTOCOL_VERSION,
  TOPIC_SCHEMAS,
  validationErrors,
} from "@ccmsg/protocol";
import { KvStore } from "../src/kv/index.ts";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import { connectUds, type LineClient } from "./client.ts";
import { SELF } from "./frames.ts";

const running: Instance[] = [];
const clients: LineClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
});

function disposable(): { env: Env; state: string } {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-kv-"));
  const home = join(root, "home");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const state = join(root, "state");
  return {
    state,
    env: {
      CLAUDE_CONFIG_DIR: home,
      CCMSG_STATE_DIR: state,
      CCMSG_CONFIG_DIR: join(root, "config"),
    },
  };
}

/** A person, greeted and ready to ask. */
async function greet(env: Env): Promise<{ instance: Instance; client: LineClient }> {
  const outcome = await start({ env, echoLog: false });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  const client = await connectUds(outcome.socketPath);
  clients.push(client);
  client.send({ op: "hello", request_id: "h", role: "user", protocol_version: PROTOCOL_VERSION });
  expect((await client.next())["ok"]).toBe(true);
  return { instance: outcome, client };
}

/** The frames one connection has written, kept so a reply and the topic frame
 * that arrived beside it can each be read by whichever helper wants it.
 *
 * A change is published while the op is still being answered, so a reader that
 * dropped what it was not looking for would drop exactly the frame the next
 * assertion is about. */
const held = new Map<LineClient, Record<string, unknown>[]>();

async function take(
  client: LineClient,
  wanted: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const queue = held.get(client) ?? [];
  held.set(client, queue);
  const at = queue.findIndex(wanted);
  if (at >= 0) return queue.splice(at, 1)[0] as Record<string, unknown>;
  for (;;) {
    const frame = await client.next();
    if (wanted(frame)) return frame;
    queue.push(frame);
  }
}

/** One op, answered and held to its own response schema (§11.1). */
async function ask(
  client: LineClient,
  op: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  client.send({ op, request_id: op, ...args });
  const answer = await take(client, (frame) => frame["request_id"] === op);
  if (answer["ok"] === true) {
    expect(validationErrors(OP_SCHEMAS[op as "kv_read"].response, answer)).toEqual([]);
  }
  return answer;
}

function nextTopic(client: LineClient, topic: string): Promise<Record<string, unknown>> {
  return take(client, (frame) => frame["ev"] === "topic" && frame["topic"] === topic);
}

function entriesOf(frame: Record<string, unknown>): KvEntry[] {
  return (frame["data"] as { entries: KvEntry[] }).entries;
}

describe("the values a client keeps here", () => {
  test("a value written is read back with the instant it carries", async () => {
    const { env } = disposable();
    const { client } = await greet(env);
    const written = await ask(client, "kv_write", {
      ns: "theme",
      key: "default",
      value: { hue: 250 },
    });
    expect(written["ok"]).toBe(true);
    const read = await ask(client, "kv_read", { ns: "theme", key: "default" });
    expect(read["value"]).toEqual({ hue: 250 });
    expect(read["updated_at"]).toBe(written["updated_at"] as number);
  });

  test("a caller may state when the write it is reporting happened", async () => {
    const { env } = disposable();
    const { client } = await greet(env);
    const at = 1_700_000_000_000;
    const written = await ask(client, "kv_write", {
      ns: "theme",
      key: "device:ipad",
      value: 1,
      updated_at: at,
    });
    expect(written["updated_at"]).toBe(at);
    expect((await ask(client, "kv_read", { ns: "theme", key: "device:ipad" }))["updated_at"]).toBe(
      at,
    );
  });

  test("a key that is not there is not there, and removing it is no error", async () => {
    const { env } = disposable();
    const { client } = await greet(env);
    const missing = await ask(client, "kv_read", { ns: "theme", key: "nothing" });
    expect((missing["error"] as { code: string }).code).toBe("not_found");
    // The caller wanted the namespace without it, and it is.
    expect((await ask(client, "kv_delete", { ns: "theme", key: "nothing" }))["ok"]).toBe(true);
    await ask(client, "kv_write", { ns: "theme", key: "default", value: 1 });
    expect((await ask(client, "kv_delete", { ns: "theme", key: "default" }))["ok"]).toBe(true);
    expect(
      ((await ask(client, "kv_read", { ns: "theme", key: "default" }))["error"] as { code: string })
        .code,
    ).toBe("not_found");
  });

  test("namespaces keep one user of the store from colliding with another", async () => {
    const { env } = disposable();
    const { client } = await greet(env);
    await ask(client, "kv_write", { ns: "theme", key: "shared", value: "a" });
    await ask(client, "kv_write", { ns: "layout", key: "shared", value: "b" });
    expect((await ask(client, "kv_read", { ns: "theme", key: "shared" }))["value"]).toBe("a");
    expect((await ask(client, "kv_read", { ns: "layout", key: "shared" }))["value"]).toBe("b");
    await ask(client, "kv_delete", { ns: "theme", key: "shared" });
    expect((await ask(client, "kv_read", { ns: "layout", key: "shared" }))["value"]).toBe("b");
  });

  test("a value outlives the instance that was asked to keep it (§3.6)", async () => {
    const { env } = disposable();
    const first = await greet(env);
    await ask(first.client, "kv_write", { ns: "theme", key: "default", value: { hue: 12 } });
    await first.client.close();
    clients.length = 0;
    await first.instance.stop();
    running.length = 0;

    // A restart is the whole of "apply a config change" (§8.2), so what a
    // person saved has to still be there afterwards.
    const second = await greet(env);
    expect((await ask(second.client, "kv_read", { ns: "theme", key: "default" }))["value"]).toEqual(
      {
        hue: 12,
      },
    );
  });
});

describe("watching a namespace (`kv:<ns>`, element)", () => {
  test("the snapshot is every entry, and a later frame only what changed", async () => {
    const { env } = disposable();
    const { client } = await greet(env);
    await ask(client, "kv_write", { ns: "theme", key: "default", value: 1 });
    await ask(client, "kv_write", { ns: "theme", key: "device:ipad", value: 2 });

    client.send({ op: "topic_subscribe", request_id: "sub", topic: "kv:theme" });
    const snapshot = await nextTopic(client, "kv:theme");
    expect(snapshot["snapshot"]).toBe(true);
    expect(validationErrors(TOPIC_SCHEMAS.kv, snapshot)).toEqual([]);
    expect(
      entriesOf(snapshot)
        .map((entry) => entry.key)
        .sort(),
    ).toEqual(["default", "device:ipad"]);
    // A snapshot never carries a removal: what is gone is simply not in it.
    expect(entriesOf(snapshot).some((entry) => entry.deleted === true)).toBe(false);

    await ask(client, "kv_write", { ns: "theme", key: "default", value: 3 });
    const change = await nextTopic(client, "kv:theme");
    expect(change["snapshot"]).toBeUndefined();
    expect(validationErrors(TOPIC_SCHEMAS.kv, change)).toEqual([]);
    expect(entriesOf(change)).toEqual([
      { key: "default", value: 3, updated_at: entriesOf(change)[0]?.updated_at ?? 0 },
    ]);
  });

  test("a removal travels as a marked entry, since an absence would say nothing", async () => {
    const { env } = disposable();
    const { client } = await greet(env);
    await ask(client, "kv_write", { ns: "theme", key: "default", value: 1 });
    client.send({ op: "topic_subscribe", request_id: "sub", topic: "kv:theme" });
    await nextTopic(client, "kv:theme");

    await ask(client, "kv_delete", { ns: "theme", key: "default" });
    const change = await nextTopic(client, "kv:theme");
    expect(validationErrors(TOPIC_SCHEMAS.kv, change)).toEqual([]);
    const [entry] = entriesOf(change);
    expect(entry?.key).toBe("default");
    expect(entry?.deleted).toBe(true);
    expect(entry?.value).toBeUndefined();
  });

  test("one namespace's frames stay out of another's", async () => {
    const { env } = disposable();
    const { client } = await greet(env);
    client.send({ op: "topic_subscribe", request_id: "sub", topic: "kv:theme" });
    await nextTopic(client, "kv:theme");
    await ask(client, "kv_write", { ns: "layout", key: "pane", value: 1 });
    await ask(client, "kv_write", { ns: "theme", key: "default", value: 2 });
    // The theme's own change is the next frame on it: nothing the other
    // namespace did arrived in between.
    expect(entriesOf(await nextTopic(client, "kv:theme"))[0]?.key).toBe("default");
  });
});

describe("the store on its own", () => {
  test("a namespace's file is read the first time it is touched", () => {
    const { state } = disposable();
    const dir = join(state, "kv");
    const published: { topic: string; data: unknown }[] = [];
    const store = new KvStore(dir, SELF, (topic, data) => {
      published.push({ topic, data });
    });
    store.write({ ns: "theme", key: "default", value: "one" }, 5);
    expect(published).toEqual([
      { topic: "kv:theme", data: { entries: [{ key: "default", value: "one", updated_at: 5 }] } },
    ]);
    // Another store over the same directory holds what the first one wrote,
    // which is what a restart is from here.
    const other = new KvStore(dir, SELF, () => undefined);
    expect(other.read({ ns: "theme", key: "default" })).toEqual({
      value: "one",
      updated_at: 5,
    });
  });
});
