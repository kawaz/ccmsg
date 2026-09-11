/** What changes when a config home runs Codex instead of Claude Code.
 *
 * The four places the harness is read: which config a directory is registered
 * with, where a transcript is found, what says a session is there, and how a
 * message reaches one. The Codex CLI is stood in for wherever one would be
 * run — what is being tested is that ccmsg asks for the right thing, and a
 * test that ran the real one would be queueing a message into somebody's
 * thread.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InboxMessage, type InstanceId, Sid, validationErrors } from "@ccmsg/protocol";
import { add, harnessFor } from "../src/daemon/index.ts";
import { currentSession } from "../src/harness/index.ts";
import { DEFAULT_CONFIG, loadShared, parseConfig } from "../src/instance/config.ts";
import {
  type Instance,
  isRunning,
  resolveConfigHome,
  resolvePaths,
  start,
} from "../src/instance/index.ts";
import { CodexQueueRoute } from "../src/messaging/index.ts";
import { HOOKS_FILE, install, status, uninstall } from "../src/plugin/index.ts";
import { isLive, Sessions } from "../src/sessions/index.ts";
import { readRecord, TranscriptFiles, TranscriptFold } from "../src/transcript/index.ts";

const dirs: string[] = [];
const running: Sessions[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A Codex config home, as `daemon add --harness codex` requires one: the
 * settings file Codex keeps its own configuration in. */
function codexHome(): string {
  const dir = temp("ccmsg-codex-home-");
  writeFileSync(join(dir, "config.toml"), "");
  return dir;
}

/** One rollout, filed where and as the Codex recorder files it. */
function rollout(home: string, date: string, name: string): string {
  const dir = join(home, "sessions", ...date.split("/"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "");
  return file;
}

/** The environment `daemon add` and `resolvePaths` read, pointed at temporary
 * directories so no config of a person's is touched. */
function env(): Record<string, string> {
  return {
    HOME: temp("ccmsg-codex-fakehome-"),
    CCMSG_CONFIG_DIR: temp("ccmsg-codex-config-"),
    CCMSG_STATE_DIR: temp("ccmsg-codex-state-"),
  };
}

afterEach(() => {
  for (const domain of running.splice(0)) domain.stop("peers");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
  test("a config home runs Claude Code unless its entry says otherwise", () => {
    expect(DEFAULT_CONFIG.harness).toBe("claude");
    expect(parseConfig("c.json", {}).harness).toBe("claude");
    expect(parseConfig("c.json", { harness: "codex" }).harness).toBe("codex");
  });

  test("a harness nobody speaks is a config that is wrong rather than ignored", () => {
    expect(() => parseConfig("c.json", { harness: "cursor" })).toThrow(/harness must be one of/);
  });

  test("`daemon add --harness codex` writes it down, and the instance reads it back", () => {
    const at = env();
    const home = codexHome();
    add(at, home, "codex");
    const shared = loadShared(resolvePaths(at).configFile);
    expect(shared.instances[0]).toEqual({ dir: home, settings: { harness: "codex" } });
    expect(harnessFor(at, home)).toBe("codex");
  });

  test("the default is not written down, so an entry states only what differs", () => {
    const at = env();
    const home = temp("ccmsg-claude-home-");
    writeFileSync(join(home, "settings.json"), "{}");
    add(at, home);
    expect(loadShared(resolvePaths(at).configFile).instances[0]?.settings).toEqual({});
  });

  test("a directory is a config home when it holds that harness's own settings", () => {
    const at = env();
    // A Codex home has no `settings.json`, and Claude Code's has no
    // `config.toml`: each is refused by the other's check.
    expect(() => add(at, codexHome())).toThrow(/settings\.json/);
    const claude = temp("ccmsg-claude-home-");
    writeFileSync(join(claude, "settings.json"), "{}");
    expect(() => add(at, claude, "codex")).toThrow(/config\.toml/);
  });
});

describe("transcripts", () => {
  test("a rollout is found by the thread its name carries", () => {
    const home = codexHome();
    const file = rollout(
      home,
      "2026/09/10",
      "rollout-2026-09-10T15-10-23-01a089f0-5415-7b91-8400-39f3f40b408d.jsonl",
    );
    const files = new TranscriptFiles({
      harness: "codex",
      configHome: home,
      announced: () => undefined,
    });
    expect(files.path("01a089f0-5415-7b91-8400-39f3f40b408d" as Sid)).toBe(file);
    expect(files.all().map((each) => each.sid)).toEqual(["01a089f0-5415-7b91-8400-39f3f40b408d"]);
  });

  test("a reverted thread's new rollout still names the same session", () => {
    const home = codexHome();
    const file = rollout(
      home,
      "2026/09/10",
      "rollout-2026-09-10T15-10-23-01a089f0-5415-7b91-8400-39f3f40b408d_01a089f0-b66f-7472-963f-426e3d48d76e.jsonl",
    );
    const files = new TranscriptFiles({
      harness: "codex",
      configHome: home,
      announced: () => undefined,
    });
    expect(files.path("01a089f0-5415-7b91-8400-39f3f40b408d" as Sid)).toBe(file);
  });

  test("what is not a rollout is not a transcript", () => {
    const home = codexHome();
    rollout(home, "2026/09/10", "notes.jsonl");
    rollout(home, "2026/09/10", "01a089f0-5415-7b91-8400-39f3f40b408d.jsonl");
    const files = new TranscriptFiles({
      harness: "codex",
      configHome: home,
      announced: () => undefined,
    });
    expect(files.all()).toEqual([]);
  });

  test("Claude Code's own tree is untouched by any of this", () => {
    const home = temp("ccmsg-claude-home-");
    const dir = join(home, "projects", "-Users-someone-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607.jsonl"), "");
    const files = new TranscriptFiles({
      harness: "claude",
      configHome: home,
      announced: () => undefined,
    });
    expect(files.all()[0]?.project).toBe("-Users-someone-repo");
  });
});

describe("route (a)", () => {
  const THREAD = "01a089f0-5415-7b91-8400-39f3f40b408d" as Sid;
  const message: InboxMessage = {
    mid: "m-1",
    from: "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607",
    from_label: "personal",
    text: "動いてる?",
    sent_at: 1_700_000_000_000,
  };

  test("a message is queued against the thread, in the config home this instance answers for", async () => {
    const seen: { args: readonly string[]; env: Record<string, string> }[] = [];
    const route = new CodexQueueRoute({
      configHome: "/tmp/a-codex-home",
      run: (args, at) => {
        seen.push({ args, env: at });
        return Promise.resolve({ code: 0 });
      },
    });
    expect(await route.send(THREAD, message)).toBe("delivered");
    expect(seen[0]?.args.slice(0, 3)).toEqual(["queue", "--thread", THREAD]);
    expect(seen[0]?.args[3]).toBe("--message");
    // What the model reads, which is the contract's wording for this route:
    // the message has to carry who it is from and how to answer it.
    expect(seen[0]?.args[4]).toContain(message.text);
    expect(seen[0]?.args[4]).toContain(message.mid);
    expect(seen[0]?.env).toEqual({ CODEX_HOME: "/tmp/a-codex-home" });
  });

  test("a queue that would not take it is the route not applying, and route (b) follows", async () => {
    const route = new CodexQueueRoute({
      configHome: "/tmp/a-codex-home",
      run: () => Promise.resolve({ code: 1 }),
    });
    expect(await route.send(THREAD, message)).toBe("unavailable");
  });

  test("a CLI that never answers is the route not applying, not a send held open", async () => {
    // The real one answers at once (measured), and this is what the budget is
    // for: `message_send` must not wait on a child's whole life.
    const route = new CodexQueueRoute({
      configHome: "/tmp/a-codex-home",
      run: () => Promise.resolve({ code: 124 }),
    });
    expect(await route.send(THREAD, message)).toBe("unavailable");
  });

  test("no `codex` on PATH is the same answer", async () => {
    const route = new CodexQueueRoute({
      configHome: "/tmp/a-codex-home",
      run: () => Promise.resolve({ code: 127 }),
    });
    expect(await route.send(THREAD, message)).toBe("unavailable");
  });
});

describe("plugin", () => {
  /** Codex's own CLI, stood in for: the one thing ccmsg asks it is whether
   * hooks are switched on. */
  const codex = (hooks: string) => ({
    run: () =>
      Promise.resolve({ code: 0, stdout: `apps stable true\nhooks stable ${hooks}\n`, stderr: "" }),
  });

  function paths(home: string) {
    return resolvePaths({ ...env(), CODEX_HOME: home });
  }

  test("the hooks and the skill are laid down where Codex reads them", async () => {
    const home = codexHome();
    const at = paths(home);
    const done = await install(at, "codex", "9.9.9", codex("true").run);

    expect(done.ok).toBe(true);
    const declared = JSON.parse(await Bun.file(join(home, HOOKS_FILE)).text()) as {
      hooks: Record<string, { hooks: { type?: string; command: string }[] }[]>;
    };
    expect(Object.keys(declared.hooks).sort()).toEqual(["SessionEnd", "SessionStart"]);
    const start = declared.hooks["SessionStart"]?.[0]?.hooks[0]?.command ?? "";
    expect(existsSync(start)).toBe(true);
    // The hook names the config home rather than trusting the environment, so
    // a session started against the default home still greets this instance.
    expect(await Bun.file(start).text()).toContain(`CODEX_HOME='${home}'`);
    expect(await Bun.file(start).text()).toContain("ccmsg hello --hook");
    expect(existsSync(join(home, "skills", "ccmsg", "SKILL.md"))).toBe(true);
    // Trust is Codex's to ask for and the person's to give.
    expect(done.needs).toContain("trust");
  });

  test("hooks that were already there are kept, and ours are not doubled", async () => {
    const home = codexHome();
    const at = paths(home);
    writeFileSync(
      join(home, HOOKS_FILE),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/mine" }] }],
        },
      }),
    );
    await install(at, "codex", "9.9.9", codex("true").run);
    await install(at, "codex", "9.9.9", codex("true").run);
    const declared = JSON.parse(await Bun.file(join(home, HOOKS_FILE)).text()) as {
      hooks: Record<string, { hooks: { type?: string; command: string }[] }[]>;
    };
    const commands = (declared.hooks["SessionStart"] ?? []).flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(commands.filter((command) => command === "/usr/local/bin/mine")).toHaveLength(1);
    expect(commands.filter((command) => command.includes("session-start"))).toHaveLength(1);
  });

  test("uninstall takes back what it put there and leaves the rest", async () => {
    const home = codexHome();
    const at = paths(home);
    writeFileSync(
      join(home, HOOKS_FILE),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/mine" }] }],
        },
      }),
    );
    await install(at, "codex", "9.9.9", codex("true").run);
    const done = await uninstall(at, "codex", codex("true").run);

    expect(done.ok).toBe(true);
    const declared = JSON.parse(await Bun.file(join(home, HOOKS_FILE)).text()) as {
      hooks: Record<string, { hooks: { type?: string; command: string }[] }[]>;
    };
    expect(declared.hooks).toEqual({
      SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/mine" }] }],
    });
    expect(existsSync(join(home, "skills", "ccmsg"))).toBe(false);
  });

  test("a config home that had no hooks file is left without one", async () => {
    const home = codexHome();
    const at = paths(home);
    await install(at, "codex", "9.9.9", codex("true").run);
    await uninstall(at, "codex", codex("true").run);
    expect(existsSync(join(home, HOOKS_FILE))).toBe(false);
  });

  test("status says whether Codex has hooks switched on at all", async () => {
    const home = codexHome();
    const at = paths(home);
    await install(at, "codex", "9.9.9", codex("true").run);
    expect((await status(at, "codex", codex("true").run)).hooks_enabled).toBe(true);
    const off = await status(at, "codex", codex("false").run);
    expect(off.hooks_enabled).toBe(false);
  });

  test("an install into a Codex home whose hooks are off says what is missing", async () => {
    const home = codexHome();
    const done = await install(paths(home), "codex", "9.9.9", codex("false").run);
    expect(done.needs).toContain("features.hooks");
  });
});

describe("what says a session is there", () => {
  const SELF = "3f9c1a7b5e2d48069c1a7b5e2d480691" as InstanceId;
  const THREAD = "01a089f0-5415-7b91-8400-39f3f40b408d" as Sid;

  function domainFor(home: string) {
    const domain = new Sessions({
      harness: "codex",
      self: SELF,
      configHome: home,
      stateDir: temp("ccmsg-codex-state-"),
      capabilities: [],
      version: "0.0.1",
      startedAt: 1_757_000_000_000,
      publish: () => {},
      pollMs: 50,
    });
    running.push(domain);
    return domain;
  }

  /** The lock the Codex thread store holds while a thread has a live writer
   * (measured against codex-cli 0.153.4). */
  function lock(home: string, sid: string): string {
    const dir = join(home, "thread-writer-locks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".coordination.lock"), "");
    const file = join(dir, `${sid}.lock`);
    writeFileSync(file, "");
    return file;
  }

  test("a thread with a live writer is live, and one whose lock is gone is not", () => {
    const home = codexHome();
    const domain = domainFor(home);
    expect(domain.classify(THREAD)).toBeUndefined();

    const file = lock(home, THREAD);
    // Nothing can be typed into a Codex thread the way a terminal is typed
    // into, so a live thread this instance holds no connection of reads as
    // live and unmanaged.
    expect(domain.classify(THREAD)).toBe("live_unmanaged");

    rmSync(file);
    expect(domain.classify(THREAD)).toBeUndefined();
  });

  test("the store's own coordination lock names no thread", () => {
    const home = codexHome();
    const domain = domainFor(home);
    mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
    writeFileSync(join(home, "thread-writer-locks", ".coordination.lock"), "");
    expect(domain.peerRows().filter(isLive)).toEqual([]);
    expect(domain.agentRows()).toEqual([]);
  });

  test("`agents` is Claude Code's own list, so a Codex instance reports none", () => {
    const home = codexHome();
    const domain = domainFor(home);
    lock(home, THREAD);
    expect(domain.agentRows()).toEqual([]);
  });
});

describe("the fold", () => {
  /** Lines as the Codex recorder writes them (measured against codex-cli
   * 0.153.4 with an isolated CODEX_HOME). */
  const ROLLOUT = [
    {
      timestamp: "2026-09-10T06:33:06.852Z",
      type: "session_meta",
      payload: { id: "01a08a05-1fc9-7272-ac75-035f3e181f74", cwd: "/tmp/work" },
    },
    { timestamp: "2026-09-10T06:33:06.860Z", type: "event_msg", payload: { type: "task_started" } },
    {
      timestamp: "2026-09-10T06:33:06.895Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "instructions nobody typed" }],
      },
    },
    {
      // Codex opens a thread by stating the environment as a `user` row. It is
      // not a person, and the fold turns it away for opening with a tag.
      timestamp: "2026-09-10T06:33:07.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context>\n  <cwd>/tmp/work</cwd>\n</environment_context>",
          },
        ],
      },
    },
    {
      timestamp: "2026-09-10T06:33:07.544Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "動いてる?" }],
      },
    },
    {
      timestamp: "2026-09-10T06:33:08.839Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    },
  ].map((row) => JSON.stringify(row));

  test("a rollout says when a person last spoke, and the environment Codex states is not a person", () => {
    const fold = new TranscriptFold();
    for (const line of ROLLOUT) fold.line(line);
    expect(fold.facts.last_user_input_at).toBe(Date.parse("2026-09-10T06:33:07.544Z"));

    // Without the row a person typed, the environment row does not stand in
    // for one: a thread nobody has spoken into has no last human input.
    const quiet = new TranscriptFold();
    for (const line of ROLLOUT.filter((line) => !line.includes("動いてる"))) quiet.line(line);
    expect(quiet.facts.last_user_input_at).toBeUndefined();
  });

  test("what a rollout does not record stays unsaid rather than guessed at", () => {
    const fold = new TranscriptFold();
    for (const line of ROLLOUT) fold.line(line);
    expect(fold.facts.api_error).toBeUndefined();
    expect(fold.facts.model).toBeUndefined();
    expect(fold.facts.todos).toEqual([]);
    expect(fold.facts.teammates).toEqual([]);
  });

  test("both directions of a rollout are read, and its instructions are not a person", () => {
    const records = ROLLOUT.map((line) => readRecord(line));
    expect(records.map((record) => record?.said_by)).toEqual([
      undefined,
      undefined,
      undefined,
      "user",
      "user",
      "agent",
    ]);
    expect(records[0]?.cwd).toBe("/tmp/work");
    expect(records[5]?.text).toBe("ok");
  });
});

describe("which session a process is inside", () => {
  test("a session of one harness started from a session of the other reads as the inner one", () => {
    // Measured: a Codex session started from a Claude Code session inherits
    // that session's whole environment, so both homes and both session ids are
    // named at once. Claude Code exports its id into everything it starts;
    // Codex names its thread to its own turn's commands, so that claim wins.
    const nested = {
      CLAUDE_CONFIG_DIR: "/homes/claude",
      CLAUDE_CODE_SESSION_ID: "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607",
      CODEX_HOME: "/homes/codex",
      CODEX_THREAD_ID: "01a089f0-5415-7b91-8400-39f3f40b408d",
    };
    expect(currentSession(nested)).toEqual({
      harness: "codex",
      sid: "01a089f0-5415-7b91-8400-39f3f40b408d",
    });
    expect(resolveConfigHome(nested)).toBe("/homes/codex");
  });

  test("a Claude Code session with no Codex around it is unchanged", () => {
    const plain = {
      CLAUDE_CONFIG_DIR: "/homes/claude",
      CLAUDE_CODE_SESSION_ID: "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607",
    };
    expect(currentSession(plain)?.harness).toBe("claude");
    expect(resolveConfigHome(plain)).toBe("/homes/claude");
  });

  test("a config home named with no session around it still resolves", () => {
    expect(resolveConfigHome({ CODEX_HOME: "/homes/codex" })).toBe("/homes/codex");
    expect(currentSession({ CODEX_HOME: "/homes/codex" })).toBeUndefined();
  });

  test("the hook Codex runs speaks for the session it fired for, and for no other", async () => {
    const home = codexHome();
    const at = resolvePaths({ ...env(), CODEX_HOME: home });
    await install(at, "codex", "9.9.9", () =>
      Promise.resolve({ code: 0, stdout: "hooks stable true\n", stderr: "" }),
    );
    const script = await Bun.file(join(at.pluginsDir, "codex", "hooks", "session-start")).text();
    // The other harness's home and session id are dropped rather than left to
    // be inherited from whoever started the Codex session.
    expect(script).toContain("-u CLAUDE_CONFIG_DIR");
    expect(script).toContain("-u CLAUDE_CODE_SESSION_ID");
    expect(script).toContain(`CODEX_HOME='${home}'`);
  });

  test("the hook script runs, names this config home and drops the other harness's", async () => {
    // A path holding a quote is still one path to the shell, and what the hook
    // hands ccmsg is what the install decided rather than what it inherited.
    const home = temp("ccmsg-codex-quote'-");
    writeFileSync(join(home, "config.toml"), "");
    const at = resolvePaths({ ...env(), CODEX_HOME: home });
    await install(at, "codex", "9.9.9", () =>
      Promise.resolve({ code: 0, stdout: "hooks stable true\n", stderr: "" }),
    );
    const bin = temp("ccmsg-codex-bin-");
    writeFileSync(
      join(bin, "ccmsg"),
      '#!/bin/sh\necho "$CODEX_HOME"\necho "${CLAUDE_CONFIG_DIR-unset}"\n',
      {
        mode: 0o755,
      },
    );
    const ran = Bun.spawn({
      cmd: [join(at.pluginsDir, "codex", "hooks", "session-start")],
      env: { PATH: bin, CLAUDE_CONFIG_DIR: "/homes/claude" },
      stdout: "pipe",
      stdin: "ignore",
    });
    const said = (await new Response(ran.stdout).text()).trim().split("\n");
    expect(await ran.exited).toBe(0);
    expect(said[0]).toBe(home);
    expect(said[1]).toBe("unset");
  });
});

describe("a Codex thread id is a sid", () => {
  /** What Codex names a thread, as a real session hands it to the commands a
   * tool runs (measured, codex-cli 0.153.4): a UUIDv7, so the third block
   * opens with a `7` that no UUIDv4 ever carries. */
  const THREAD_ID = "01a08a1e-b0d7-78c1-a9e2-d61560138fac";

  test("the contract takes it, so a Codex session is addressable as it stands", () => {
    expect(validationErrors(Sid, THREAD_ID)).toEqual([]);
  });

  test("every place ccmsg reads a sid out of a name takes it too", () => {
    const home = codexHome();
    const file = rollout(home, "2026/09/10", `rollout-2026-09-10T15-10-23-${THREAD_ID}.jsonl`);
    const files = new TranscriptFiles({
      harness: "codex",
      configHome: home,
      announced: () => undefined,
    });
    expect(files.path(THREAD_ID as Sid)).toBe(file);

    mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
    writeFileSync(join(home, "thread-writer-locks", `${THREAD_ID}.lock`), "");
    const domain = new Sessions({
      harness: "codex",
      self: "3f9c1a7b5e2d48069c1a7b5e2d480691" as InstanceId,
      configHome: home,
      stateDir: temp("ccmsg-codex-state-"),
      capabilities: [],
      version: "0.0.1",
      startedAt: 1_757_000_000_000,
      publish: () => {},
      pollMs: 50,
    });
    running.push(domain);
    expect(domain.classify(THREAD_ID as Sid)).toBe("live_unmanaged");
  });

  test("it is what a session running under Codex says it is", () => {
    expect(currentSession({ CODEX_THREAD_ID: THREAD_ID })).toEqual({
      harness: "codex",
      sid: THREAD_ID,
    });
    // Both variables carry the same thread UUID, so either answers.
    expect(currentSession({ CODEX_SESSION_ID: THREAD_ID })?.sid).toBe(THREAD_ID);
  });
});

describe("which config home an instance answers for", () => {
  const started: Instance[] = [];

  afterEach(async () => {
    for (const instance of started.splice(0)) await instance.stop();
  });

  test("a `daemon run <dir>` from inside a session of the other harness still answers for <dir>", async () => {
    const claude = temp("ccmsg-claude-home-");
    writeFileSync(join(claude, "settings.json"), "{}");
    const outcome = await start({
      configHome: claude,
      echoLog: false,
      // The environment of a Codex turn, which is what a `daemon run` issued
      // from one carries. The directory was named, so nothing here decides.
      env: {
        ...env(),
        CODEX_HOME: codexHome(),
        CODEX_THREAD_ID: "01a08a1e-b0d7-78c1-a9e2-d61560138fac",
      },
    });
    expect(isRunning(outcome)).toBe(true);
    if (!isRunning(outcome)) return;
    started.push(outcome);
    expect(outcome.paths.configHome).toBe(claude);
  });

  test("with no directory named, the session the process is inside decides", async () => {
    const codex = codexHome();
    const outcome = await start({
      echoLog: false,
      env: {
        ...env(),
        CLAUDE_CONFIG_DIR: temp("ccmsg-claude-home-"),
        CLAUDE_CODE_SESSION_ID: "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607",
        CODEX_HOME: codex,
        CODEX_THREAD_ID: "01a08a1e-b0d7-78c1-a9e2-d61560138fac",
      },
    });
    expect(isRunning(outcome)).toBe(true);
    if (!isRunning(outcome)) return;
    started.push(outcome);
    expect(outcome.paths.configHome).toBe(codex);
  });
});
