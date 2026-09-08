import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DirTreeEntry,
  type LauncherRunResult,
  OP_SCHEMAS,
  type OpName,
  validationErrors,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../src/dispatch/index.ts";
import type { LauncherConfig } from "../src/instance/index.ts";
import { type Launch, Launcher, launcherHandlers, program } from "../src/launcher/index.ts";
import { TestConn } from "./frames.ts";

/** A tree of directories to browse and launch in, with a dot-directory and a
 * link out of the roots to be refused. */
function host(): { root: string; outside: string } {
  // What the filesystem calls it: every path in a reply is the resolved one,
  // and on this host the temporary directory is reached through a link.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccmsg-launcher-")));
  const root = join(base, "repos");
  mkdirSync(join(root, "one", "src", "deep"), { recursive: true });
  mkdirSync(join(root, "two"), { recursive: true });
  mkdirSync(join(root, ".hidden"), { recursive: true });
  writeFileSync(join(root, "one", "README.md"), "");
  const outside = join(base, "elsewhere");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, "away"));
  return { root, outside };
}

function config(root: string, extra: Partial<LauncherConfig> = {}): LauncherConfig {
  return {
    root_dirs: [root],
    templates: [
      {
        name: "claude",
        command: 'printf "%s|%s" "$MODEL" "$PROMPT"',
        shell: "bash",
        params: [
          { name: "MODEL", default: "opus" },
          { name: "PROMPT", default: "" },
        ],
      },
      { name: "plain", command: "printf plain", shell: "bash", params: [] },
    ],
    depth: 2,
    timeout_secs: 10,
    clean_env: [],
    keep_env: [],
    ...extra,
  };
}

/** Run one op the way dispatch would, and hold its answer to the contract: a
 * body that does not pass the op's own response schema is a violation even when
 * the assertions below are happy (§11.1). */
async function run(
  op: OpName,
  handler: (input: HandlerInput) => unknown,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const identity = { state: "settled" as const, role: "user" as const };
  const body = (await handler({
    op,
    args: { op, request_id: "1", ...args },
    conn: new TestConn(identity),
    identity,
  })) as object;
  expect(validationErrors(OP_SCHEMAS[op].response, { ok: true, request_id: "1", ...body })).toEqual(
    [],
  );
  return body as Record<string, unknown>;
}

async function refusalOf(call: () => unknown): Promise<string> {
  try {
    await call();
  } catch (cause) {
    if (cause instanceof OpError) return cause.code;
    throw cause;
  }
  throw new Error("the call was not refused");
}

/** A launcher whose launches are watched rather than run. */
function watched(cfg: LauncherConfig, env: Record<string, string | undefined> = {}) {
  const launches: Launch[] = [];
  const launcher = new Launcher(cfg, {
    env,
    run: (launch) => {
      launches.push(launch);
      return Promise.resolve({ stdout: "", stderr: "", exit_code: 0, timed_out: false });
    },
  });
  return { launcher, launches };
}

/** Every path in a tree, so a walk's shape can be stated in one line. */
function paths(entries: readonly DirTreeEntry[]): string[] {
  return entries.flatMap((entry) => [entry.path, ...paths(entry.children ?? [])]);
}

describe("the form a client renders (launcher_config_read)", () => {
  test("answers the roots and the recipes, in configured order", async () => {
    const { root } = host();
    const answer = await run(
      "launcher_config_read",
      launcherHandlers(new Launcher(config(root))).launcher_config_read,
    );
    expect(answer["root_dirs"]).toEqual([root]);
    expect(answer["templates"]).toEqual([
      {
        name: "claude",
        command: 'printf "%s|%s" "$MODEL" "$PROMPT"',
        params: [
          { name: "MODEL", default: "opus" },
          { name: "PROMPT", default: "" },
        ],
      },
      { name: "plain", command: "printf plain", params: [] },
    ]);
  });

  test("the shell a recipe runs under is the instance's business", async () => {
    const { root } = host();
    const answer = await run(
      "launcher_config_read",
      launcherHandlers(new Launcher(config(root))).launcher_config_read,
    );
    for (const template of answer["templates"] as Record<string, unknown>[]) {
      expect(Object.keys(template).sort()).toEqual(["command", "name", "params"]);
    }
  });
});

describe("where a session could run (dir_tree)", () => {
  const tree = (root: string, args: Record<string, unknown>) =>
    run("dir_tree", launcherHandlers(new Launcher(config(root))).dir_tree, args);

  test("walks the configured depth, directories only", async () => {
    const { root } = host();
    const answer = await tree(root, { roots: [root] });
    expect(paths(answer["entries"] as DirTreeEntry[])).toEqual([
      join(root, "one"),
      join(root, "one", "src"),
      join(root, "two"),
    ]);
  });

  test("one level says nothing about what is below it, so a client may ask", async () => {
    const { root } = host();
    const answer = await tree(root, { roots: [root], depth: 1 });
    const entries = answer["entries"] as DirTreeEntry[];
    expect(entries.map((entry) => entry.path)).toEqual([join(root, "one"), join(root, "two")]);
    expect(entries[0]?.children).toBeUndefined();
    // The lazy expansion the absence invites, asked for as a descendant.
    const below = await tree(root, { roots: [join(root, "one")], depth: 1 });
    expect((below["entries"] as DirTreeEntry[]).map((entry) => entry.path)).toEqual([
      join(root, "one", "src"),
    ]);
  });

  test("a directory with no subdirectories says so rather than staying silent", async () => {
    const { root } = host();
    const answer = await tree(root, { roots: [join(root, "two")] });
    expect(answer["entries"]).toEqual([]);
    const one = await tree(root, { roots: [root], depth: 3 });
    const deep = paths(one["entries"] as DirTreeEntry[]);
    expect(deep).toContain(join(root, "one", "src", "deep"));
  });

  test("a filter keeps what matches and the ancestors it hangs from", async () => {
    const { root } = host();
    const answer = await tree(root, { roots: [root], depth: 3, filter: "deep" });
    expect(paths(answer["entries"] as DirTreeEntry[])).toEqual([
      join(root, "one"),
      join(root, "one", "src"),
      join(root, "one", "src", "deep"),
    ]);
    // An emptied search box is not a filter that matches nothing.
    const cleared = await tree(root, { roots: [root], filter: "" });
    expect((cleared["entries"] as DirTreeEntry[]).length).toBe(2);
  });

  test("a root outside the configured ones contributes nothing, and refuses nothing", async () => {
    const { root, outside } = host();
    const answer = await tree(root, { roots: [outside, root], depth: 1 });
    // The op states no refusal for a path: the reply is the roots it could
    // answer for, and the one it could not is simply not in it.
    expect((answer["entries"] as DirTreeEntry[]).map((entry) => entry.path)).toEqual([
      join(root, "one"),
      join(root, "two"),
    ]);
  });

  test("dot-directories and links out of the roots are not places to run", async () => {
    const { root } = host();
    const answer = await tree(root, { roots: [root], depth: 1 });
    const shown = (answer["entries"] as DirTreeEntry[]).map((entry) => entry.path);
    expect(shown).not.toContain(join(root, ".hidden"));
    expect(shown).not.toContain(join(root, "away"));
  });
});

describe("assembling a launch (launcher_run)", () => {
  test("the directory is the resolved one, and the recipe the default", async () => {
    const { root } = host();
    const { launcher, launches } = watched(config(root));
    await run("launcher_run", launcherHandlers(launcher).launcher_run, {
      cwd: join(root, "one"),
      params: {},
    });
    const launch = launches[0];
    expect(launch?.cwd).toBe(join(root, "one"));
    expect(launch?.argv[0]).toBe("bash");
    expect(launch?.argv.at(-1)).toContain('printf "%s|%s"');
    expect(launch?.timeoutMs).toBe(10_000);
  });

  test("a directory outside the roots is refused before anything is started", async () => {
    const { root, outside } = host();
    const { launcher, launches } = watched(config(root));
    expect(
      await refusalOf(() => launcherHandlers(launcher).launcher_run(input({ cwd: outside }))),
    ).toBe("invalid_args");
    expect(launches).toEqual([]);
  });

  test("values reach the command as variables, defaults filling what was left out", async () => {
    const { root } = host();
    const { launcher, launches } = watched(config(root));
    await run("launcher_run", launcherHandlers(launcher).launcher_run, {
      cwd: root,
      params: { PROMPT: "$(rm -rf /) 'quoted'" },
    });
    const launch = launches[0];
    // Nothing a caller sent is in the shell text, so nothing it sent is syntax.
    expect(launch?.argv.at(-1)).not.toContain("rm -rf");
    expect(launch?.env["ccmsg_launch_param_PROMPT"]).toBe("$(rm -rf /) 'quoted'");
    expect(launch?.env["ccmsg_launch_param_MODEL"]).toBe("opus");
  });

  test("a parameter the recipe does not declare is a bug worth surfacing", async () => {
    const { root } = host();
    const { launcher, launches } = watched(config(root));
    expect(
      await refusalOf(() =>
        launcherHandlers(launcher).launcher_run(
          input({ cwd: root, params: { NOPE: "x" }, template: "plain" }),
        ),
      ),
    ).toBe("invalid_args");
    expect(launches).toEqual([]);
  });

  test("a recipe that is not configured is refused rather than replaced", async () => {
    const { root } = host();
    const { launcher } = watched(config(root));
    expect(
      await refusalOf(() =>
        launcherHandlers(launcher).launcher_run(input({ cwd: root, template: "other" })),
      ),
    ).toBe("invalid_args");
  });

  test("a named recipe and an edited command are both honoured", async () => {
    const { root } = host();
    const { launcher, launches } = watched(config(root));
    await run("launcher_run", launcherHandlers(launcher).launcher_run, {
      cwd: root,
      params: {},
      template: "plain",
    });
    expect(launches[0]?.argv.at(-1)).toContain("printf plain");
    await run("launcher_run", launcherHandlers(launcher).launcher_run, {
      cwd: root,
      params: {},
      template: "plain",
      command: "printf edited",
    });
    expect(launches[1]?.argv.at(-1)).toContain("printf edited");
  });

  test("the environment a session inherits is the one clean_env leaves", async () => {
    const { root } = host();
    const { launcher, launches } = watched(
      config(root, { clean_env: ["CLAUDE*"], keep_env: ["CLAUDE_CONFIG_DIR"] }),
      { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "/homes/.claude", PATH: "/bin" },
    );
    await run("launcher_run", launcherHandlers(launcher).launcher_run, { cwd: root, params: {} });
    const env = launches[0]?.env ?? {};
    expect(env["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/homes/.claude");
    expect(env["PATH"]).toBe("/bin");
  });

  test("the prologue takes every value out of the environment before the command", () => {
    const text = program(["MODEL"], "echo $MODEL");
    expect(text).toBe(
      'unset -v MODEL; MODEL="$ccmsg_launch_param_MODEL"; unset -v ccmsg_launch_param_MODEL\necho $MODEL',
    );
  });
});

describe("running the command (no terminal, a plain shell)", () => {
  test("the output, the code, and the values the command read", async () => {
    const { root } = host();
    const launcher = new Launcher(config(root));
    const answer = (await run("launcher_run", launcherHandlers(launcher).launcher_run, {
      cwd: root,
      params: { PROMPT: "hi there" },
    })) as unknown as LauncherRunResult;
    expect(answer.stdout).toBe("opus|hi there");
    expect(answer.exit_code).toBe(0);
    expect(answer.timed_out).toBe(false);
  });

  test("a command that outlives its allowance is stopped and says so", async () => {
    const { root } = host();
    const launcher = new Launcher(
      config(root, {
        timeout_secs: 1,
        templates: [{ name: "slow", command: "sleep 30", shell: "bash", params: [] }],
      }),
    );
    const answer = (await run("launcher_run", launcherHandlers(launcher).launcher_run, {
      cwd: root,
      params: {},
    })) as unknown as LauncherRunResult;
    expect(answer.timed_out).toBe(true);
    // A signal ended it, so there is no code to state.
    expect(answer.exit_code).toBeUndefined();
  });
});

function input(args: Record<string, unknown>): HandlerInput {
  const identity = { state: "settled" as const, role: "user" as const };
  return {
    op: "launcher_run",
    args: { op: "launcher_run", request_id: "1", params: {}, ...args },
    conn: new TestConn(identity),
    identity,
  };
}
