/** What ccmsg installs into an agent, and what it takes back out.
 *
 * The agent's own CLI is stood in for rather than run: what is being tested is
 * that ccmsg asks for the right things in the right order and undoes exactly
 * what it did, and a test that ran the real one would be writing into
 * somebody's config home to find that out. The stand-in is not a script of
 * expected calls — it keeps the state the real one keeps and reads the plugin's
 * manifest off the disk, so a plugin that was never written is a plugin it
 * cannot install.
 *
 * The two hooks are exercised against a real instance, because what they are
 * for is what the instance makes of them: a greeting that names where the
 * session works, and a departure that is a pause rather than a disappearance.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LastLiveSession, PROTOCOL_VERSION } from "@ccmsg/protocol";
import { hello, stopping } from "../src/cli.ts";
import { statedMeta } from "../src/greeting/index.ts";
import {
  type Instance,
  type InstancePaths,
  isRunning,
  resolvePaths,
  start,
} from "../src/instance/index.ts";
import {
  install,
  MARKETPLACE_NAME,
  PLUGIN_ID,
  type Ran,
  type Receipt,
  type Run,
  status,
  uninstall,
} from "../src/plugin/index.ts";
import { connectUds, type LineClient } from "./client.ts";
import { SID } from "./frames.ts";

const VERSION = "9.9.9";

const OWNED = [
  "CLAUDE_CONFIG_DIR",
  "CCMSG_STATE_DIR",
  "CCMSG_CONFIG_DIR",
  "CLAUDE_CODE_SESSION_ID",
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

/** A config home and a state directory of this test's own, and the paths one
 * instance derives from them. */
function home(): InstancePaths {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-plugin-"));
  dirs.push(root);
  mkdirSync(join(root, "home", "sessions"), { recursive: true });
  env("CLAUDE_CONFIG_DIR", join(root, "home"));
  env("CCMSG_STATE_DIR", join(root, "state"));
  env("CCMSG_CONFIG_DIR", join(root, "config"));
  return resolvePaths();
}

/** Claude Code as far as `ccmsg plugin` can see it: the marketplaces it knows,
 * the plugins it holds, and the answers its two `--json` listings give.
 *
 * The install reads the version out of the manifest ccmsg wrote, which is what
 * makes this a stand-in for the agent rather than a recording of it — nothing
 * is installed that was not laid down first. */
function agent(): {
  run: Run;
  commands: string[][];
  markets: Map<string, string>;
  held: Map<string, string>;
} {
  const commands: string[][] = [];
  const markets = new Map<string, string>();
  const held = new Map<string, string>();
  const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });
  const run: Run = async (args) => {
    commands.push([...args]);
    const [, second, third, fourth] = args;
    if (second === "marketplace" && third === "add" && fourth !== undefined) {
      const manifest = join(fourth, ".claude-plugin", "marketplace.json");
      if (!existsSync(manifest)) return { code: 1, stdout: "", stderr: "no marketplace there" };
      const name = (JSON.parse(await Bun.file(manifest).text()) as { name: string }).name;
      markets.set(name, fourth);
      return ok();
    }
    if (second === "marketplace" && third === "remove" && fourth !== undefined) {
      return markets.delete(fourth) ? ok() : { code: 1, stdout: "", stderr: "no such marketplace" };
    }
    if (second === "marketplace" && third === "list") {
      return ok(
        JSON.stringify([...markets].map(([name, path]) => ({ name, source: "directory", path }))),
      );
    }
    if (second === "install" && third !== undefined) {
      const where = markets.get(third.split("@")[1] ?? "");
      if (where === undefined) return { code: 1, stdout: "", stderr: "no marketplace offers it" };
      const plugin = JSON.parse(
        await Bun.file(join(where, ".claude-plugin", "plugin.json")).text(),
      ) as {
        version: string;
      };
      held.set(third, plugin.version);
      return ok();
    }
    if (second === "uninstall" && third !== undefined) {
      return held.delete(third) ? ok() : { code: 1, stdout: "", stderr: "not installed" };
    }
    if (second === "list") {
      return ok(JSON.stringify([...held].map(([id, version]) => ({ id, version, enabled: true }))));
    }
    return { code: 1, stdout: "", stderr: `unknown: ${args.join(" ")}` };
  };
  return { run, commands, markets, held };
}

async function receiptOf(paths: InstancePaths): Promise<Receipt> {
  return JSON.parse(
    await Bun.file(join(paths.pluginsDir, "claude.receipt.json")).text(),
  ) as Receipt;
}

describe("ccmsg plugin install", () => {
  test("the plugin is laid down under the instance's state and registered with the agent", async () => {
    const paths = home();
    const claude = agent();

    const done = await install(paths, VERSION, claude.run);

    expect(done.ok).toBe(true);
    const root = join(paths.pluginsDir, "claude");
    expect(claude.commands).toEqual([
      ["plugin", "marketplace", "add", root],
      ["plugin", "list", "--json"],
      ["plugin", "install", PLUGIN_ID],
    ]);
    expect(claude.markets.get(MARKETPLACE_NAME)).toBe(root);
    expect(claude.held.get(PLUGIN_ID)).toBe(VERSION);
  });

  test("the receipt names every file written and every command run", async () => {
    const paths = home();
    const claude = agent();

    await install(paths, VERSION, claude.run);

    const receipt = await receiptOf(paths);
    expect(receipt).toMatchObject({
      agent: "claude",
      version: VERSION,
      config_home: paths.configHome,
      root: join(paths.pluginsDir, "claude"),
      marketplace: MARKETPLACE_NAME,
      plugin_id: PLUGIN_ID,
    });
    expect(receipt.files).toEqual([
      ".claude-plugin/marketplace.json",
      ".claude-plugin/plugin.json",
      "skills/ccmsg/SKILL.md",
      "hooks/hooks.json",
    ]);
    for (const path of receipt.files) expect(existsSync(join(receipt.root, path))).toBe(true);
    expect(receipt.commands).toEqual([
      ["plugin", "marketplace", "add", receipt.root],
      ["plugin", "install", PLUGIN_ID],
    ]);
  });

  test("installing again replaces the copy the agent took, rather than leaving the old one", async () => {
    const paths = home();
    const claude = agent();
    await install(paths, "0.0.1", claude.run);

    const again = await install(paths, VERSION, claude.run);

    expect(again.ok).toBe(true);
    expect(claude.held.get(PLUGIN_ID)).toBe(VERSION);
    expect(claude.commands).toContainEqual(["plugin", "uninstall", PLUGIN_ID, "-y"]);
  });

  test("a step the agent refuses leaves a receipt for the steps that happened", async () => {
    const paths = home();
    const refusing: Run = async (args) =>
      args[1] === "marketplace" && args[2] === "add"
        ? { code: 1, stdout: "", stderr: "そんな marketplace は追加できません" }
        : { code: 0, stdout: "[]", stderr: "" };

    const done = await install(paths, VERSION, refusing);

    expect(done.ok).toBe(false);
    expect(done.report.at(-1)).toContain("そんな marketplace は追加できません");
    const receipt = await receiptOf(paths);
    expect(receipt.commands).toEqual([]);
    expect(receipt.marketplace).toBeUndefined();
    expect(receipt.plugin_id).toBeUndefined();
  });
});

describe("the plugin's files", () => {
  async function laid(): Promise<{ root: string; read: (path: string) => Promise<string> }> {
    const paths = home();
    await install(paths, VERSION, agent().run);
    const root = join(paths.pluginsDir, "claude");
    return { root, read: (path) => Bun.file(join(root, path)).text() };
  }

  test("the manifests are the pair Claude Code reads a marketplace and a plugin from", async () => {
    const { root, read } = await laid();

    const marketplace = JSON.parse(await read(".claude-plugin/marketplace.json")) as {
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string; description: string }[];
    };
    expect(marketplace.name).toBe(MARKETPLACE_NAME);
    expect(marketplace.owner.name).toBe("kawaz");
    // `./` is the marketplace's own directory, which is where the plugin is:
    // one directory carries both manifests, and `marketplace add <root>` is
    // therefore the whole of what the agent has to be told.
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({ name: "ccmsg", source: "./" });

    const plugin = JSON.parse(await read(".claude-plugin/plugin.json")) as {
      name: string;
      version: string;
    };
    expect(plugin).toMatchObject({ name: "ccmsg", version: VERSION });
    expect(existsSync(join(root, ".claude-plugin"))).toBe(true);
  });

  test("the hooks say hello and goodbye through the ccmsg on PATH, and are quiet without one", async () => {
    const { read } = await laid();

    const hooks = JSON.parse(await read("hooks/hooks.json")) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
    };
    expect(Object.keys(hooks.hooks).sort()).toEqual(["SessionEnd", "SessionStart"]);

    const start = hooks.hooks["SessionStart"]?.[0];
    expect(start?.matcher).toBe("startup|resume|clear|compact");
    expect(start?.hooks[0]?.type).toBe("command");
    expect(start?.hooks[0]?.command).toContain("ccmsg hello --hook");

    const end = hooks.hooks["SessionEnd"]?.[0];
    expect(end?.hooks[0]?.command).toContain("ccmsg stopping --hook");

    // Neither command names the plugin's own directory: the binary comes from
    // PATH, and a session without one leaves without saying anything.
    for (const event of Object.values(hooks.hooks)) {
      for (const command of event[0]?.hooks ?? []) {
        expect(command.command).not.toContain("CLAUDE_PLUGIN_ROOT");
        expect(command.command).toContain("command -v ccmsg");
      }
    }
  });

  test("the skill is a SKILL.md with the frontmatter a skill is found by", async () => {
    const { read } = await laid();

    const skill = await read("skills/ccmsg/SKILL.md");
    const [, frontmatter] = skill.split("---\n");
    expect(frontmatter).toContain("name: ccmsg");
    expect(frontmatter).toContain("description: ");
    // The one thing a session has to do with a message it receives.
    expect(skill).toContain("Reply with: ccmsg reply");
  });
});

describe("ccmsg plugin status", () => {
  test("with nothing installed it says so, and names a plugin somebody else put there", async () => {
    const paths = home();
    const claude = agent();

    const clean = await status(paths, claude.run);
    expect(clean.report.join("\n")).toContain("ccmsg からは入れていません");

    claude.markets.set(MARKETPLACE_NAME, "/somewhere/else");
    claude.held.set(PLUGIN_ID, "1.2.3");
    const foreign = await status(paths, claude.run);
    expect(foreign.report.join("\n")).toContain("ccmsg 以外が入れたものです");
  });

  test("it reads the receipt against what is actually there", async () => {
    const paths = home();
    const claude = agent();
    await install(paths, VERSION, claude.run);

    const agreed = await status(paths, claude.run);
    expect(agreed.report.join("\n")).toContain("件すべてあります");
    expect(agreed.report.join("\n")).toContain("登録どおりです");
    expect(agreed.report.join("\n")).toContain(`${PLUGIN_ID}: ${VERSION} が入っています`);

    // The two ways the world moves out from under a receipt: somebody removed
    // the plugin, and somebody deleted what it was reading.
    claude.held.delete(PLUGIN_ID);
    rmSync(join(paths.pluginsDir, "claude", "hooks", "hooks.json"));
    const drifted = await status(paths, claude.run);
    expect(drifted.report.join("\n")).toContain("hooks/hooks.json");
    expect(drifted.report.join("\n")).toContain(`${PLUGIN_ID}: 入っていません`);
  });
});

describe("ccmsg plugin uninstall", () => {
  test("what install did is exactly what uninstall undoes", async () => {
    const paths = home();
    const claude = agent();
    await install(paths, VERSION, claude.run);
    const root = join(paths.pluginsDir, "claude");

    const done = await uninstall(paths, claude.run);

    expect(done.ok).toBe(true);
    expect(claude.held.has(PLUGIN_ID)).toBe(false);
    expect(claude.markets.has(MARKETPLACE_NAME)).toBe(false);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(paths.pluginsDir, "claude.receipt.json"))).toBe(false);
    expect(claude.commands.slice(-2)).toEqual([
      ["plugin", "uninstall", PLUGIN_ID, "-y"],
      ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
    ]);
  });

  test("nothing anybody else installed is touched", async () => {
    const paths = home();
    const claude = agent();
    claude.markets.set("theirs", "/their/marketplace");
    claude.held.set("theirs@theirs", "1.0.0");
    await install(paths, VERSION, claude.run);

    await uninstall(paths, claude.run);

    expect(claude.markets.get("theirs")).toBe("/their/marketplace");
    expect(claude.held.get("theirs@theirs")).toBe("1.0.0");
  });

  test("with no receipt there is nothing to undo and the agent is not asked to", async () => {
    const paths = home();
    const claude = agent();

    const done = await uninstall(paths, claude.run);

    expect(done.ok).toBe(true);
    expect(claude.commands).toEqual([]);
  });

  test("a half-finished install gives back only its half", async () => {
    const paths = home();
    const refusing: Run = async (args) =>
      args[1] === "marketplace" && args[2] === "add"
        ? { code: 1, stdout: "", stderr: "だめ" }
        : { code: 0, stdout: "[]", stderr: "" };
    await install(paths, VERSION, refusing);
    const claude = agent();

    const done = await uninstall(paths, claude.run);

    expect(done.ok).toBe(true);
    // Nothing was registered, so nothing is unregistered; the files that were
    // written are the whole of what there is to take away.
    expect(claude.commands).toEqual([]);
    expect(existsSync(join(paths.pluginsDir, "claude"))).toBe(false);
  });
});

describe("what a session says about where it works", () => {
  test("a worktree is the workspace and its container is the repository", () => {
    const answered = statedMeta("/repos/ccmsg/main", () => "/repos/ccmsg/main\nfeature-x\n");
    expect(answered).toEqual({
      repo: "ccmsg",
      ws: "main",
      cwd: "/repos/ccmsg/main",
      repo_root: "/repos/ccmsg",
      branch: "feature-x",
    });
  });

  test("a head on no branch names none, rather than a branch called HEAD", () => {
    expect(
      statedMeta("/repos/ccmsg/main", () => "/repos/ccmsg/main\nHEAD\n").branch,
    ).toBeUndefined();
  });

  test("outside a repository only the working directory is stated", () => {
    expect(statedMeta("/tmp/nowhere", () => undefined)).toEqual({ cwd: "/tmp/nowhere" });
  });
});

describe("the hooks against a running instance", () => {
  async function instance(): Promise<Instance> {
    const outcome = await start({ echoLog: false });
    if (!isRunning(outcome)) throw new Error("another instance holds this config home");
    running.push(outcome);
    return outcome;
  }

  async function watch(at: Instance): Promise<LineClient> {
    const client = await connectUds(at.socketPath);
    clients.push(client);
    client.send({
      op: "hello",
      request_id: "hello",
      protocol_version: PROTOCOL_VERSION,
      role: "user",
    });
    expect((await client.next())["ok"]).toBe(true);
    client.send({ op: "topic_subscribe", request_id: "sub", topic: "peers" });
    expect((await client.next())["ok"]).toBe(true);
    return client;
  }

  interface Peers {
    peers: { sid: string; repo?: string; ws?: string; cwd?: string }[];
    last_live: LastLiveSession[];
  }

  async function until(client: LineClient, want: (data: Peers) => boolean): Promise<Peers> {
    for (;;) {
      const data = (await client.next())["data"] as Peers | undefined;
      if (data?.peers !== undefined && want(data)) return data;
    }
  }

  /** One harness state file, which is what makes a sid a session this config
   * home has rather than one that only ever greeted.
   *
   * The pid is this process's, because the harness's rows are only the ones
   * whose process is still there — a made-up number reads as a session that
   * has already gone, which is the opposite of what these tests are about. */
  function harnessRow(paths: InstancePaths, sid: string): void {
    writeFileSync(
      join(paths.configHome, "sessions", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: sid,
        cwd: "/repos/ccmsg/main",
        kind: "interactive",
        startedAt: Date.now(),
      }),
    );
  }

  test("the session-start hook names where the session works, and leaving costs it nothing", async () => {
    const paths = home();
    harnessRow(paths, SID);
    const at = await instance();
    const watcher = await watch(at);

    expect(
      await hello(["--sid", SID, "--repo", "ccmsg", "--ws", "main", "--cwd", "/repos/ccmsg/main"]),
    ).toBe(0);

    // While it is connected the instance repeats what it was told, which is
    // what a message from this session is shown as having come from.
    const greeted = await until(watcher, (data) => data.peers.some((row) => row.sid === SID));
    expect(greeted.peers.find((row) => row.sid === SID)).toMatchObject({
      repo: "ccmsg",
      ws: "main",
      cwd: "/repos/ccmsg/main",
    });

    // And the greeting ending is not the session ending: the harness still
    // names it, so nothing is written down as having stopped being live.
    const gone = await until(watcher, (data) => !data.peers.some((row) => row.sid === SID));
    expect(gone.last_live.some((row) => row.sid === SID)).toBe(false);
  });

  test("a greeting with no instance behind it costs the session nothing", async () => {
    home();
    expect(await hello(["--sid", SID])).toBe(0);
  });

  test("the session-end hook reads the session and the reason off the event it is handed", async () => {
    // No harness row here: the pause is written when the session stops being
    // live, and a row says it still is. The hook runs while the session is on
    // its way out, so what this test is about is the declaration arriving from
    // the event — what the row does to the timing is the test above.
    home();
    env("CLAUDE_CODE_SESSION_ID", undefined);
    const at = await instance();
    const watcher = await watch(at);

    const event = JSON.stringify({
      session_id: SID,
      hook_event_name: "SessionEnd",
      reason: "prompt_input_exit",
      cwd: "/repos/ccmsg/main",
    });
    expect(await stopping(["--hook"], () => Promise.resolve(event))).toBe(0);

    // Declared and then gone is a pause, which is the difference the hook
    // exists to make: the harness still names the session, and it is the
    // declaration that puts it on the list at all.
    const paused = await until(watcher, (data) => data.last_live.some((row) => row.sid === SID));
    expect(paused.last_live.find((row) => row.sid === SID)).toMatchObject({ state: "paused" });
    expect(paused.last_live.find((row) => row.sid === SID)?.stopped_at).toBeGreaterThan(0);
  });
});
