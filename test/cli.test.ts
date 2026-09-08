import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InboxMessage,
  type LastLiveSession,
  type Notification,
  PROTOCOL_VERSION,
} from "@ccmsg/protocol";
import { main, say, type Spawn } from "../src/cli.ts";
import { type Instance, isRunning, start } from "../src/instance/index.ts";
import { connectUds, type LineClient } from "./client.ts";
import { OTHER_SID, SID } from "./frames.ts";

/** The CLI reads its own environment — that is how a session names itself and
 * how an instance is found — so a test drives it by setting one. */
const OWNED = [
  "CLAUDE_CONFIG_DIR",
  "CCMSG_STATE_DIR",
  "CCMSG_CONFIG_DIR",
  "CLAUDE_CODE_SESSION_ID",
  "CCMSG_SAY_BIN",
] as const;

const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
const running: Instance[] = [];
const clients: LineClient[] = [];

function env(name: (typeof OWNED)[number], value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An instance of its own, with the environment pointed at it. */
async function instance(): Promise<Instance> {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-cli-"));
  dirs.push(root);
  mkdirSync(join(root, "home", "sessions"), { recursive: true });
  env("CLAUDE_CONFIG_DIR", join(root, "home"));
  env("CCMSG_STATE_DIR", join(root, "state"));
  env("CCMSG_CONFIG_DIR", join(root, "config"));
  const outcome = await start({ echoLog: false });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  return outcome;
}

async function greet(
  at: Instance,
  identity: { role: "user" } | { role: "session"; sid: string },
): Promise<LineClient> {
  const client = await connectUds(at.socketPath);
  clients.push(client);
  client.send({
    op: "hello",
    request_id: "hello",
    protocol_version: PROTOCOL_VERSION,
    ...identity,
  });
  expect((await client.next())["ok"]).toBe(true);
  return client;
}

async function subscribe(client: LineClient, topic: string): Promise<void> {
  client.send({ op: "topic_subscribe", request_id: `sub-${topic}`, topic });
  expect((await client.next())["ok"]).toBe(true);
}

/** The `last_live` rows of the next `peers` frame that satisfies `want`.
 * Frames arrive for every recompute, so a test waits for the one carrying the
 * row it is about rather than assuming which one that is. */
async function until(
  client: LineClient,
  want: (rows: LastLiveSession[]) => boolean,
): Promise<LastLiveSession[]> {
  for (;;) {
    const frame = await client.next();
    const data = frame["data"] as { last_live?: LastLiveSession[] } | undefined;
    const rows = data?.last_live ?? [];
    if (want(rows)) return rows;
  }
}

describe("ccmsg reply", () => {
  test("without --to the answer is for a person, so it goes out as a notification", async () => {
    const at = await instance();
    const watcher = await greet(at, { role: "user" });
    await subscribe(watcher, "notify");

    // The line the contract writes for a message from a person: a `mid` and no
    // addressee, run exactly as it is handed over.
    expect(await main(["reply", `${at.self}/1`, "人への返事", "--sid", SID])).toBe(0);

    const frame = await watcher.next();
    expect(frame["ev"]).toBe("topic");
    expect(frame["topic"]).toBe("notify");
    expect(frame["data"]).toMatchObject({ sid: SID, text: "人への返事" });
  });

  test("a reply to a person is not held for anyone", async () => {
    const at = await instance();
    const listener = await greet(at, { role: "session", sid: OTHER_SID });
    await subscribe(listener, "inbox");
    expect((await listener.next())["data"]).toEqual([]);

    expect(await main(["reply", `${at.self}/1`, "人への返事", "--sid", SID])).toBe(0);
    expect(await main(["post", OTHER_SID, "こちらは通常のメッセージ", "--sid", SID])).toBe(0);

    // The next thing on the inbox is the ordinary message, so nothing of the
    // reply took this route: it was a notification and nothing else.
    const [message] = (await listener.next())["data"] as InboxMessage[];
    expect(message?.text).toBe("こちらは通常のメッセージ");
  });

  test("with --to it is a message to that session", async () => {
    const at = await instance();
    const listener = await greet(at, { role: "session", sid: OTHER_SID });
    await subscribe(listener, "inbox");
    expect((await listener.next())["data"]).toEqual([]);

    expect(
      await main(["reply", `${at.self}/1`, "セッションへの返事", "--to", OTHER_SID, "--sid", SID]),
    ).toBe(0);

    const [message] = (await listener.next())["data"] as InboxMessage[];
    expect(message).toMatchObject({
      from: SID,
      text: "セッションへの返事",
      reply_to: `${at.self}/1`,
    });
  });
});

describe("ccmsg notify", () => {
  test("--about names the session it is about", async () => {
    const at = await instance();
    const watcher = await greet(at, { role: "user" });
    await subscribe(watcher, "notify");

    expect(await main(["notify", "隣の話", "--about", OTHER_SID, "--sid", SID])).toBe(0);

    expect((await watcher.next())["data"]).toMatchObject({ sid: OTHER_SID, text: "隣の話" });
  });
});

describe("ccmsg stopping", () => {
  test("a session that says it is going leaves as paused, and one that just goes disappears", async () => {
    const at = await instance();
    const watcher = await greet(at, { role: "user" });
    await subscribe(watcher, "peers");

    // The command greets as the session, declares, and leaves: the declaration
    // and the disconnection are one event in that order, and the entry written
    // when the connection closes is what carries the instant.
    expect(await main(["stopping", "--sid", SID])).toBe(0);
    const paused = await until(watcher, (rows) => rows.some((row) => row.sid === SID));
    expect(paused.find((row) => row.sid === SID)).toMatchObject({ state: "paused" });
    expect(paused.find((row) => row.sid === SID)?.stopped_at).toBeGreaterThan(0);

    // The same departure without the declaration is the other outcome.
    await (await greet(at, { role: "session", sid: OTHER_SID })).close();
    const gone = await until(watcher, (rows) => rows.some((row) => row.sid === OTHER_SID));
    expect(gone.find((row) => row.sid === OTHER_SID)).toMatchObject({ state: "disappeared" });
    expect(gone.find((row) => row.sid === OTHER_SID)?.stopped_at).toBeUndefined();
  });
});

describe("ccmsg say", () => {
  /** A speech binary that makes no sound and remembers what it was asked. */
  function fake(exitCode = 0): { spawn: Spawn; commands: string[][] } {
    const commands: string[][] = [];
    return {
      commands,
      spawn: (command) => {
        commands.push(command);
        return { exited: Promise.resolve(exitCode) };
      },
    };
  }

  test("every argument reaches the speech binary untouched", async () => {
    env("CLAUDE_CODE_SESSION_ID", undefined);
    const speech = fake();
    expect(await say(["-v", "Kyoko", "-r", "220", "こんにちは"], speech.spawn)).toBe(0);
    expect(speech.commands).toEqual([["/usr/bin/say", "-v", "Kyoko", "-r", "220", "こんにちは"]]);
  });

  test("CCMSG_SAY_BIN replaces the binary, and its exit code is the command's", async () => {
    env("CLAUDE_CODE_SESSION_ID", undefined);
    env("CCMSG_SAY_BIN", "/nowhere/say");
    const speech = fake(3);
    expect(await say(["だめでした"], speech.spawn)).toBe(3);
    expect(speech.commands[0]?.[0]).toBe("/nowhere/say");
  });

  test("speaking says who spoke, and the speech still happens", async () => {
    const at = await instance();
    env("CLAUDE_CODE_SESSION_ID", SID);
    const watcher = await greet(at, { role: "user" });
    await subscribe(watcher, "notify");

    const speech = fake();
    expect(await say(["喋ります"], speech.spawn)).toBe(0);

    const notification = (await watcher.next())["data"] as Notification;
    expect(notification).toMatchObject({ sid: SID, text: "喋ります" });
    expect(speech.commands).toEqual([["/usr/bin/say", "喋ります"]]);
  });

  test("no instance to tell is not a reason to stay silent", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccmsg-cli-"));
    dirs.push(root);
    env("CLAUDE_CONFIG_DIR", join(root, "home"));
    env("CCMSG_STATE_DIR", join(root, "state"));
    env("CCMSG_CONFIG_DIR", join(root, "config"));
    env("CLAUDE_CODE_SESSION_ID", SID);

    const speech = fake();
    expect(await say(["誰も聞いていない"], speech.spawn)).toBe(0);
    expect(speech.commands).toEqual([["/usr/bin/say", "誰も聞いていない"]]);
  });
});
