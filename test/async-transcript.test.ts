import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { type Env, Instance, isRunning, start } from "../src/instance/index.ts";
import { connectUds, type LineClient } from "./client.ts";
import { OTHER_SID, SID } from "./frames.ts";
import { trackRoot } from "./harness.ts";

/** How much transcript the instance is made to read: three sessions of a size
 * a long-running one really reaches, together inside the search's own scan
 * budget so that every byte of them is read rather than the walk stopping
 * early. */
const RECORDS = 60_000;
const SAID = "the quick brown fox jumps over the lazy dog. ".repeat(5);

/** How long the search is left running before the ping is asked.
 *
 * The ping has to land while a transcript is being read, not while the walk is
 * still listing them: the listing is a handful of directory reads and hands the
 * loop back on its own, so a ping answered during it would say nothing about
 * the reading that follows. Well inside the scan, which takes several times
 * this long on the corpus above. */
const PROBE_MS = 80;

const running: Instance[] = [];
const clients: LineClient[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The sessions whose transcripts are written. One of them is the case where
 * the whole scan is a single file, which is where handing the loop back has to
 * happen inside the reading of one transcript rather than between two. */
const SESSIONS = [SID, OTHER_SID, "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f608"];

/** A config home with transcripts of tens of megabytes in it. */
function loaded(sids: readonly string[] = SESSIONS, records = RECORDS): Env {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-async-transcript-"));
  trackRoot(root);
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "settings.json"), "{}\n");
  const project = join(home, "projects", "-repos-a-repo-main");
  mkdirSync(project, { recursive: true });
  const body = Array.from(
    { length: records },
    (_, at) =>
      `${JSON.stringify({
        type: "user",
        uuid: `u${String(at)}`,
        cwd: "/repos/a-repo/main",
        timestamp: new Date(1_757_000_000_000 + at).toISOString(),
        message: { role: "user", content: `${SAID} ${String(at)}` },
      })}\n`,
  ).join("");
  for (const sid of sids) writeFileSync(join(project, `${sid}.jsonl`), body);
  return {
    CLAUDE_CONFIG_DIR: home,
    CCMSG_STATE_DIR: join(root, "state"),
    CCMSG_CACHE_DIR: join(root, "cache"),
    CCMSG_CONFIG_DIR: join(root, "config"),
  };
}

/** The answers to the requests named, in the order they arrived and with the
 * moment each came back.
 *
 * Read off the one connection and told apart by the request each names, never
 * by the order they come in: which of them answers first is what the case is
 * about, so it is something the case asserts rather than something it assumes. */
async function answers(
  client: LineClient,
  wanted: readonly string[],
): Promise<{ back: Map<string, { frame: Record<string, unknown>; at: number }>; order: string[] }> {
  const back = new Map<string, { frame: Record<string, unknown>; at: number }>();
  const order: string[] = [];
  while (back.size < wanted.length) {
    const frame = await client.next();
    const id = frame["request_id"];
    if (typeof id !== "string" || !wanted.includes(id)) continue;
    order.push(id);
    back.set(id, { frame, at: performance.now() });
  }
  return { back, order };
}

/** Ask for a search of everything, and a ping from the middle of it. */
async function pingMidSearch(client: LineClient) {
  const searching = performance.now();
  client.send({ op: "session.search", request_id: "search", query: "lazy dog" });
  await Bun.sleep(PROBE_MS);
  const asked = performance.now();
  client.send({ op: "instance.ping", request_id: "ping" });
  const { back, order } = await answers(client, ["search", "ping"]);
  return { searching, asked, back, order };
}

describe("reading a transcript does not stop the instance (DR: async IO)", () => {
  test("a ping is answered from the middle of a search of tens of megabytes", async () => {
    const instance = await start({ env: loaded(), echoLog: false });
    if (!isRunning(instance)) throw new Error("another instance holds this config home");
    running.push(instance);
    const client = await connectUds(instance.socketPath);
    clients.push(client);
    client.send({ op: "hello.user", request_id: "hello", protocol_version: PROTOCOL_VERSION });
    expect((await client.next())["ok"]).toBe(true);

    // The op that reads every byte of every transcript, and then — while it is
    // in the middle of doing so — the op that answers out of memory.
    const { searching, asked, back, order } = await pingMidSearch(client);

    const search = back.get("search");
    const ping = back.get("ping");
    // Every transcript was read, so the search really did spend the bytes this
    // case is about rather than answering off a walk that found nothing.
    expect(search?.frame["hits"]).toHaveLength(3);
    // The probe landed inside the reading rather than after it.
    expect((search?.at ?? 0) - searching).toBeGreaterThan(PROBE_MS * 2);
    // What the case is about, said twice. That the ping comes back first rests
    // on no number: an instance reading a transcript without handing the loop
    // back could only answer it once that reading was done. How far ahead it is
    // is then measured against what the search still had left to do, so that a
    // slower machine moves both sides of the comparison.
    expect(order[0]).toBe("ping");
    expect((ping?.at ?? Infinity) - asked).toBeLessThan(((search?.at ?? 0) - asked) / 5);
  }, 60_000);

  test("and from the middle of reading one transcript, not only between two", async () => {
    // One file for the whole scan, so that nothing but the reading of that one
    // transcript can be what hands the loop back.
    const instance = await start({ env: loaded([SID], RECORDS * 3), echoLog: false });
    if (!isRunning(instance)) throw new Error("another instance holds this config home");
    running.push(instance);
    const client = await connectUds(instance.socketPath);
    clients.push(client);
    client.send({ op: "hello.user", request_id: "hello", protocol_version: PROTOCOL_VERSION });
    expect((await client.next())["ok"]).toBe(true);

    const { searching, asked, back, order } = await pingMidSearch(client);

    const search = back.get("search");
    const ping = back.get("ping");
    expect(search?.frame["hits"]).toHaveLength(1);
    expect((search?.at ?? 0) - searching).toBeGreaterThan(PROBE_MS * 2);
    expect(order[0]).toBe("ping");
    expect((ping?.at ?? Infinity) - asked).toBeLessThan(((search?.at ?? 0) - asked) / 5);
  }, 60_000);

  test("and from the middle of the read a subscription opens with", async () => {
    // The other route into a whole transcript: a subscription is answered once
    // the file has been folded (CT-Q8), so the subscriber waits — and nobody
    // else does.
    const instance = await start({ env: loaded([SID], RECORDS * 3), echoLog: false });
    if (!isRunning(instance)) throw new Error("another instance holds this config home");
    running.push(instance);
    const client = await connectUds(instance.socketPath);
    clients.push(client);
    client.send({ op: "hello.user", request_id: "hello", protocol_version: PROTOCOL_VERSION });
    expect((await client.next())["ok"]).toBe(true);

    const subscribing = performance.now();
    client.send({
      op: "topic.subscribe",
      request_id: "subscribe",
      topic: `transcript.items:${SID}`,
    });
    await Bun.sleep(PROBE_MS);
    const asked = performance.now();
    client.send({ op: "instance.ping", request_id: "ping" });
    const { back, order } = await answers(client, ["subscribe", "ping"]);

    const subscribe = back.get("subscribe");
    const ping = back.get("ping");
    expect(subscribe?.frame["ok"]).toBe(true);
    // The probe landed inside the reading rather than after it.
    expect((subscribe?.at ?? 0) - subscribing).toBeGreaterThan(PROBE_MS * 2);
    expect(order[0]).toBe("ping");
    expect((ping?.at ?? Infinity) - asked).toBeLessThan(((subscribe?.at ?? 0) - asked) / 5);
  }, 60_000);
});
