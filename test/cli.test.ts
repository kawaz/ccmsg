import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InboxMessage,
  type PeerInfo,
  type Notification,
  PROTOCOL_VERSION,
} from "@ccmsg/protocol";
import { main, say, type Spawn } from "../src/cli.ts";
import { type Instance, isRunning, start } from "../src/instance/index.ts";
import { connectUds, type LineClient } from "./client.ts";
import { capture, json } from "./harness.ts";
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

/** The lost rows of `peers`, once they satisfy `want`.
 *
 * A frame carries the rows that changed, so the frames are folded the way a
 * subscriber folds them and the fold is what is waited on: the row a test is
 * about stops being named again once it has settled. */
async function until(client: LineClient, want: (rows: PeerInfo[]) => boolean): Promise<PeerInfo[]> {
  const held = new Map<string, PeerInfo>();
  for (;;) {
    const frame = await client.next();
    const data = frame["data"] as { peers?: (PeerInfo & { removed?: true })[] } | undefined;
    if (data?.peers === undefined) continue;
    for (const row of data.peers) {
      if (row.removed === true) held.delete(row.sid);
      else held.set(row.sid, row);
    }
    const lost = [...held.values()].filter(
      (row) => row.state === "paused" || row.state === "disappeared",
    );
    if (want(lost)) return lost;
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

describe("ccmsg peers / ccmsg agents", () => {
  /** One entry per instance, which is what a cluster topic answers with. */
  type Answer = { instance: string; data: Record<string, unknown> }[];

  async function answered(args: string[]): Promise<Answer> {
    const written = await capture(() => main(args));
    expect(written.code).toBe(0);
    return json(written.out) as Answer;
  }

  test("peers is the topic's payload, under the instance that stated it", async () => {
    const at = await instance();
    // A session to be found. It stays connected, so it is in `peers` rather
    // than in the list of sessions the instance has lost.
    await greet(at, { role: "session", sid: OTHER_SID });

    const answer = await answered(["peers", "--sid", SID]);

    expect(answer).toHaveLength(1);
    const stated = answer[0] as Answer[number];
    expect(stated.instance).toBe(at.self);
    // Nothing of the payload is rewritten: the rows are under the name the
    // contract gives them, connected and lost alike in the one list.
    expect(Object.keys(stated.data).sort()).toEqual(["peers"]);
    const found = (stated.data["peers"] as { sid: string }[]).map((row) => row.sid);
    expect(found).toContain(OTHER_SID);
    // The command greeted as the session it was told it is, so that session is
    // in the list it just read.
    expect(found).toContain(SID);
  });

  test("a session the instance has lost is a row of the same list", async () => {
    const at = await instance();
    // Greeted and gone: the row stays, with the classification saying which
    // of the two it is now. There is no second list to look in.
    const session = await greet(at, { role: "session", sid: OTHER_SID });
    session.send({ op: "session_stopping", request_id: "stop" });
    expect((await session.next())["ok"]).toBe(true);
    await session.close();

    const answer = await answered(["peers"]);
    const rows = (answer[0]?.data["peers"] ?? []) as { sid: string; state?: string }[];
    expect(rows.find((row) => row.sid === OTHER_SID)?.state).toBe("paused");
  });

  test("agents is the harness's own view, which covers a session that never connected", async () => {
    const at = await instance();
    // A state file the harness would have written, naming a live process: a
    // session with no connection here at all.
    const sessions = join(at.paths.configHome, "sessions");
    writeFileSync(
      join(sessions, `${process.pid}.json`),
      JSON.stringify({
        sessionId: OTHER_SID,
        pid: process.pid,
        cwd: "/tmp",
        kind: "interactive",
        startedAt: 1,
        name: "繋いでいない方",
      }),
    );

    const answer = await answered(["agents"]);

    expect(answer).toHaveLength(1);
    expect(answer[0]?.instance).toBe(at.self);
    expect(answer[0]?.data["agents"]).toMatchObject([
      { sid: OTHER_SID, pid: process.pid, cwd: "/tmp", name: "繋いでいない方" },
    ]);
  });

  test("without an instance there is nobody to ask, and the command says which socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccmsg-cli-"));
    dirs.push(root);
    env("CLAUDE_CONFIG_DIR", join(root, "home"));
    env("CCMSG_STATE_DIR", join(root, "state"));
    env("CCMSG_CONFIG_DIR", join(root, "config"));

    const written = await capture(() => main(["peers"]));

    expect(written.code).toBe(1);
    expect((json(written.err) as { error: { code: string } }).error.code).toBe(
      "instance_unreachable",
    );
  });

  test("one instance answers --all with its own entry, and states the instances it sees", async () => {
    const at = await instance();

    const answer = await answered(["agents", "--all"]);

    // A host running one instance is a cluster of one: the same shape, with
    // one entry in it rather than a different answer.
    expect(answer.map((one) => one.instance)).toEqual([at.self]);
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

/** A session's own transcript, where this harness keeps one. */
function transcript(home: string, sid: string, text: string): void {
  const dir = join(home, "projects", "-Users-someone-a-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), text);
}

const SPOKE = `${JSON.stringify({
  type: "user",
  uuid: "u1",
  parentUuid: null,
  timestamp: "2026-09-01T00:00:00.000Z",
  message: { role: "user", content: "行を数えて" },
})}
${JSON.stringify({
  type: "assistant",
  uuid: "a1",
  parentUuid: "u1",
  timestamp: "2026-09-01T00:00:01.000Z",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "wc -l < f" } }],
  },
})}
`;

describe("ccmsg dump", () => {
  test("the instance writes the file and the command draws it", async () => {
    const at = await instance();
    transcript(process.env["CLAUDE_CONFIG_DIR"] as string, SID, SPOKE);

    const drawn = await capture(() => main(["dump", SID]));
    expect(drawn.code).toBe(0);
    expect(drawn.err).toBe("");
    // Markdown, not the JSON every other command answers with: what a dump is
    // for is somebody reading it.
    expect(drawn.out).toContain(`# dump ${SID}`);
    expect(drawn.out).toContain(`- instance: \`${at.self}\``);
    expect(drawn.out).toContain("[u1:0] message:user:in");
    expect(drawn.out).toContain("$ wc -l < f");
    expect(drawn.out).toContain("## ids");
  });

  test("--json hands over the file as the contract states it", async () => {
    await instance();
    transcript(process.env["CLAUDE_CONFIG_DIR"] as string, SID, SPOKE);

    const asked = await capture(() => main(["dump", SID, "--json"]));
    expect(asked.code).toBe(0);
    const file = json(asked.out) as { sid: string; items: { type: string }[] };
    expect(file.sid).toBe(SID);
    expect(file.items.map((one) => one.type)).toEqual(["message:user:in", "tool:Bash"]);
  });

  test("--types is applied, and --out writes instead of printing", async () => {
    await instance();
    const home = process.env["CLAUDE_CONFIG_DIR"] as string;
    transcript(home, SID, SPOKE);
    const path = join(home, "drawn.md");

    const written = await capture(() => main(["dump", SID, "--types", "tool:Bash", "--out", path]));
    expect(written.code).toBe(0);
    const answer = json(written.out) as { path: string; bytes: number };
    expect(answer.path).toBe(path);
    const text = readFileSync(path, "utf8");
    expect(answer.bytes).toBe(Buffer.byteLength(text));
    expect(text).toContain("$ wc -l < f");
    expect(text).not.toContain("message:user:in");
  });

  test("dump presets answers with what this instance is configured with", async () => {
    await instance();
    const listed = await capture(() => main(["dump", "presets"]));
    expect(listed.code).toBe(0);
    expect(json(listed.out)).toEqual({ presets: [] });
  });

  test("a preset the instance does not have is refused rather than ignored", async () => {
    await instance();
    transcript(process.env["CLAUDE_CONFIG_DIR"] as string, SID, SPOKE);
    const refused = await capture(() => main(["dump", SID, "--preset", "nowhere"]));
    expect(refused.code).toBe(1);
    expect(json(refused.err)).toMatchObject({ error: { code: "invalid_args" } });
  });
});
