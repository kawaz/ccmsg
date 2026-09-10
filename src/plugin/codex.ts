/** The plugin ccmsg hands to Codex, as its files.
 *
 * Nothing here goes through Codex's own plugin system. A Codex plugin can
 * carry skills but not hooks — `plugin_hooks` is a removed feature of
 * codex-cli 0.153.4 — and hooks are the whole point: they are how a session
 * says hello and goodbye. So what is laid down is what Codex reads out of its
 * config home directly: `hooks.json` beside its settings, and one skill under
 * `skills/`.
 *
 * That makes the install different in kind from Claude Code's. There is no
 * agent command to run and nothing to register: the files are the install, and
 * uninstall is taking back exactly the files that were put there — which is
 * why `hooks.json` is merged rather than written over, and unmerged rather than
 * deleted. */

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS, HARNESSES } from "../harness/index.ts";
import type { InstancePaths } from "../instance/index.ts";
import {
  type InstallReport,
  place,
  readReceipt,
  type Receipt,
  receiptFile,
  rootFor,
  type Run,
  type StatusReport,
  type UninstallReport,
  writeReceipt,
} from "./receipt.ts";
import { SKILL } from "./skill.ts";

/** How Codex's own CLI is run, for the one question this asks it. */
export const runCodex: Run = async (args) => {
  let spawned: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    spawned = Bun.spawn({ cmd: ["codex", ...args], stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: 127, stdout: "", stderr: "codex が PATH にありません" };
  }
  const [stdout, stderr] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
  ]);
  return { code: await spawned.exited, stdout, stderr };
};

/** The two events a session's life is read from, and the file each hook is.
 *
 * `SessionStart` and `SessionEnd` are what Codex fires around a thread, and
 * both hand the hook the thread's id and its rollout path on standard input
 * (codex-cli 0.153.4) — which is what `ccmsg hello --hook` and
 * `ccmsg stopping --hook` already read. The legacy `notify` command is not
 * used: it reports a finished turn, which is not a session's life. */
const EVENTS = [
  ["SessionStart", "session-start", "hello"],
  ["SessionEnd", "session-end", "stopping"],
] as const;

/** How long a greeting or a departure may take before Codex stops waiting on
 * it. Both are one connection to a socket on this same host, and both give up
 * on their own when there is no instance behind it. */
const HOOK_TIMEOUT_S = 5;

/** What Codex still asks of the person before the hooks fire.
 *
 * Both are Codex's own questions, asked in its interface: a hook runs once it
 * has been reviewed there, and a directory Codex has not been told to trust
 * does not load project-local hooks at all. Said rather than answered — what
 * may run on somebody's machine is theirs to decide. */
const TRUST =
  "hooks の trust が要ります (codex の hooks 画面で ccmsg の 2 つを trust。作業ディレクトリの信頼確認にも一度答えておく)";

export const HOOKS_FILE = "hooks.json";
const SKILL_FILE = join("skills", "ccmsg", "SKILL.md");

/** One hook, as a program of its own rather than as a command line.
 *
 * Codex states a hook as one `command` string, and whether it reaches a shell
 * is not something a config file says. A script settles it: the path is what
 * Codex runs, and everything that needs a shell — finding `ccmsg`, naming the
 * config home — happens inside it where a shell is certain.
 *
 * The config home is named, and every other harness's is dropped. A session
 * started against the default home has no variable saying so, and a Codex
 * session started from inside a Claude Code session inherits that session's
 * `CLAUDE_CONFIG_DIR` and session id — so a hook that only added its own would
 * still greet the other instance, as the other session (§3.8, measured). What
 * is dropped is named here rather than left to the shell: the hook has to
 * speak for the session it fired for.
 *
 * `env` is spelled absolutely because `PATH` is what the hook is about to
 * search and not something it can lean on before it has. `ccmsg` itself is
 * reached through `PATH`:
 * the binary belongs to whoever installed ccmsg, and a plugin carrying its own
 * copy would be a second version of it to keep current. A session whose `PATH`
 * has no `ccmsg` leaves without saying anything, because a person who has not
 * installed ccmsg has not asked to hear about it at every session start. */
function hookScript(configHome: string, command: string): string {
  const dropped = HARNESSES.filter((harness) => harness !== "codex").flatMap((harness) => [
    HARNESS[harness].homeEnv,
    ...HARNESS[harness].sessionEnv,
  ]);
  return `#!/bin/sh
command -v ccmsg >/dev/null 2>&1 || exit 0
exec /usr/bin/env ${dropped.map((name) => `-u ${name}`).join(" ")} CODEX_HOME=${shellQuoted(configHome)} ccmsg ${command} --hook
`;
}

/** One value as a POSIX shell reads it literally: single quotes, and the one
 * escape those admit for a single quote of their own. A config home is a path
 * a person chose, so it is quoted rather than assumed to hold nothing. */
function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Every file the plugin is made of, by its path under the plugin's root. */
export function codexPluginFiles(configHome: string): Map<string, string> {
  return new Map(
    EVENTS.map(([, file, command]) => [join("hooks", file), hookScript(configHome, command)]),
  );
}

/** What ccmsg adds to the config home's `hooks.json`. */
function hookEntries(root: string): Record<string, unknown[]> {
  const entries: Record<string, unknown[]> = {};
  for (const [event, file] of EVENTS) {
    entries[event] = [
      {
        hooks: [
          { type: "command", command: join(root, "hooks", file), timeoutSec: HOOK_TIMEOUT_S },
        ],
      },
    ];
  }
  return entries;
}

/** Lay the files down, add the hooks to the config home's own file, and write
 * down what was done.
 *
 * Repeating it is laying the same files down again and replacing the same
 * hooks: what an earlier install of ccmsg put in `hooks.json` is taken out
 * before ours goes in, so an install run twice leaves one of each rather than
 * two. */
export async function install(
  paths: InstancePaths,
  version: string,
  run: Run = runCodex,
): Promise<InstallReport> {
  const root = rootFor(paths, "codex");
  const files = codexPluginFiles(paths.configHome);
  // Executable, because Codex runs the path rather than passing it to a shell.
  await place(root, files, 0o755);
  await place(paths.configHome, new Map([[SKILL_FILE, SKILL]]));

  const hooksFile = join(paths.configHome, HOOKS_FILE);
  const held = await readHooks(hooksFile);
  await writeFile(hooksFile, `${JSON.stringify(withHooks(held, root), null, 2)}\n`);

  const receipt: Receipt = {
    agent: "codex",
    version,
    installed_at: new Date().toISOString(),
    config_home: paths.configHome,
    root,
    files: [...files.keys()],
    placed: [join(paths.configHome, SKILL_FILE), hooksFile],
    commands: [],
  };
  await writeReceipt(paths, receipt);

  // Codex will not run a command hook it has not been shown: the person has to
  // trust it once, in the session picker's hooks view. Said rather than worked
  // around — trust is Codex asking whether this program may run, and answering
  // it on their behalf is not an install's business.
  const enabled = await hooksEnabled(run);
  return {
    agent: "codex",
    ok: true,
    version,
    config_home: paths.configHome,
    root,
    files: receipt.files,
    placed: receipt.placed,
    commands: [],
    needs:
      enabled === false
        ? `codex の features.hooks が off です (codex features enable hooks で入れてから、${TRUST})`
        : `codex 側で ${TRUST}`,
  };
}

/** What the receipt says was done, beside what is actually there now. */
export async function status(paths: InstancePaths, run: Run = runCodex): Promise<StatusReport> {
  const receipt = await readReceipt(paths, "codex");
  const enabled = await hooksEnabled(run);
  const hooks = enabled === undefined ? {} : { hooks_enabled: enabled };
  if (receipt === undefined) return { agent: "codex", ok: true, ...hooks };
  const missing: string[] = [];
  for (const path of receipt.files) {
    if (!(await Bun.file(join(receipt.root, path)).exists())) missing.push(path);
  }
  for (const path of receipt.placed ?? []) {
    if (!(await Bun.file(path).exists())) missing.push(path);
  }
  const declared = await readHooks(join(receipt.config_home, HOOKS_FILE));
  return {
    agent: "codex",
    ok: true,
    receipt: receiptFile(paths, "codex"),
    installed_at: receipt.installed_at,
    version: receipt.version,
    config_home: receipt.config_home,
    root: receipt.root,
    files: {
      expected: receipt.files.length + (receipt.placed?.length ?? 0),
      present: receipt.files.length + (receipt.placed?.length ?? 0) - missing.length,
      missing,
    },
    ...hooks,
    ...(hooksOf(declared, receipt.root).length === EVENTS.length
      ? {}
      : {
          needs: `${HOOKS_FILE} に ccmsg の hook がありません (plugin install codex で入れ直せます)`,
        }),
  };
}

/** Undo what the receipt says was done, and nothing else.
 *
 * `hooks.json` is the config home's own file and may hold hooks that are
 * nobody's business but the person's, so what is taken out of it is the
 * entries pointing at the scripts this receipt names — and the file goes only
 * when nothing is left in it. */
export async function uninstall(paths: InstancePaths): Promise<UninstallReport> {
  const receipt = await readReceipt(paths, "codex");
  if (receipt === undefined) return { agent: "codex", ok: true, removed: {} };
  const file = receiptFile(paths, "codex");
  const hooksFile = join(receipt.config_home, HOOKS_FILE);
  const left = withoutHooks(await readHooks(hooksFile), receipt.root);
  if (Object.keys(left).length === 0) await rm(hooksFile, { force: true });
  else await writeFile(hooksFile, `${JSON.stringify({ hooks: left }, null, 2)}\n`);

  const placed = (receipt.placed ?? []).filter((path) => path !== hooksFile);
  for (const path of placed) await rm(path, { force: true });
  // The skill's own directory, which held nothing else.
  await rm(join(receipt.config_home, "skills", "ccmsg"), { recursive: true, force: true });
  await rm(receipt.root, { recursive: true, force: true });
  await rm(file, { force: true });
  return {
    agent: "codex",
    ok: true,
    receipt: file,
    removed: { root: receipt.root, placed: [...placed, hooksFile] },
  };
}

/** Whether Codex has hooks switched on at all, or nothing when it could not be
 * asked. Its own answer rather than a reading of `config.toml`, because the
 * effective state is the feature's stage and the config together. */
async function hooksEnabled(run: Run): Promise<boolean | undefined> {
  const ran = await run(["features", "list"]);
  if (ran.code !== 0) return undefined;
  for (const line of ran.stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "hooks") continue;
    return fields[fields.length - 1] === "true";
  }
  return undefined;
}

/** The `hooks` object of a config home's file, or nothing where there is no
 * file or it says something else. A file that cannot be read is treated as
 * holding nothing, which is what makes the merge below additive. */
async function readHooks(file: string): Promise<Record<string, unknown[]>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (typeof hooks !== "object" || hooks === null) return {};
  const held: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (Array.isArray(entries)) held[event] = entries;
  }
  return held;
}

function withHooks(held: Record<string, unknown[]>, root: string): { hooks: object } {
  const ours = hookEntries(root);
  const merged = withoutHooks(held, root);
  for (const [event, entries] of Object.entries(ours)) {
    merged[event] = [...(merged[event] ?? []), ...entries];
  }
  return { hooks: merged };
}

/** The file's hooks with every entry that runs one of ours taken out, and
 * every event left empty by that taken out with it. */
function withoutHooks(held: Record<string, unknown[]>, root: string): Record<string, unknown[]> {
  const left: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(held)) {
    const kept = entries.filter((entry) => !runsOurs(entry, root));
    if (kept.length > 0) left[event] = kept;
  }
  return left;
}

/** Whether one entry of a file's hooks runs a script of this install's. */
function runsOurs(entry: unknown, root: string): boolean {
  return hooksIn(entry).some((command) => command.startsWith(join(root, "hooks")));
}

/** Which of ccmsg's own hook scripts a file's hooks name. */
function hooksOf(held: Record<string, unknown[]>, root: string): string[] {
  return Object.values(held)
    .flat()
    .flatMap((entry) => hooksIn(entry))
    .filter((command) => command.startsWith(join(root, "hooks")));
}

function hooksIn(entry: unknown): string[] {
  const hooks = (entry as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(hooks)) return [];
  return hooks
    .map((hook) => (hook as { command?: unknown } | null)?.command)
    .filter((command): command is string => typeof command === "string");
}
