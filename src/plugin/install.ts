import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { InstancePaths } from "../instance/index.ts";
import { claudePluginFiles, MARKETPLACE_NAME, PLUGIN_ID } from "./claude.ts";
import * as codex from "./codex.ts";
import {
  type Agent,
  type InstallReport,
  place,
  type Ran,
  readReceipt,
  type Receipt,
  receiptFile,
  refusal as refusalOf,
  type Refusal,
  rootFor,
  type Run,
  type StatusReport,
  type UninstallReport,
  writeReceipt,
} from "./receipt.ts";

export const runClaude: Run = async (args) => {
  let spawned: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    spawned = Bun.spawn({ cmd: ["claude", ...args], stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: 127, stdout: "", stderr: "claude が PATH にありません" };
  }
  const [stdout, stderr] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
  ]);
  return { code: await spawned.exited, stdout, stderr };
};

/** The three commands, dispatched to the agent they are about.
 *
 * What each one installs differs in kind — Claude Code takes a plugin through
 * its own CLI, Codex reads files out of its config home — so the two are
 * written apart and only the shapes they answer with are shared. */
export function install(
  paths: InstancePaths,
  agent: Agent,
  version: string,
  run?: Run,
): Promise<InstallReport> {
  return agent === "codex"
    ? codex.install(paths, version, run)
    : installClaude(paths, version, run);
}

export function status(paths: InstancePaths, agent: Agent, run?: Run): Promise<StatusReport> {
  return agent === "codex" ? codex.status(paths, run) : statusClaude(paths, run);
}

export function uninstall(paths: InstancePaths, agent: Agent, run?: Run): Promise<UninstallReport> {
  return agent === "codex" ? codex.uninstall(paths) : uninstallClaude(paths, run);
}

/** Lay the plugin's files down under the instance's own state, register it
 * with the agent, and write down what was done.
 *
 * The two agent commands are both safe to repeat — the agent answers "already
 * there" and succeeds — so an install that is run twice is an install that
 * finishes twice rather than one that fails the second time. What is not
 * repeatable is the copy the agent takes: it snapshots the plugin at install,
 * and a version already installed is not re-read. So an install that finds its
 * own id already there removes it first, which is what makes "install" mean
 * "what is running is what was just laid down". */
async function installClaude(
  paths: InstancePaths,
  version: string,
  run: Run = runClaude,
): Promise<InstallReport> {
  const root = rootFor(paths, "claude");
  const files = claudePluginFiles(version);
  await place(root, files);

  // Kept as it grows rather than rebuilt per step: each step adds what it did
  // to what the earlier ones did, and the file on disk is that running total.
  // A receipt that named only the last step would undo only the last step.
  let receipt: Receipt = {
    agent: "claude",
    version,
    installed_at: new Date().toISOString(),
    config_home: paths.configHome,
    root,
    files: [...files.keys()],
    commands: [],
  };
  await writeReceipt(paths, receipt);

  let replaced = false;
  const so = (ok: boolean, refused?: Refusal): InstallReport => ({
    agent: "claude",
    ok,
    version,
    config_home: paths.configHome,
    root,
    files: receipt.files,
    marketplace: { name: MARKETPLACE_NAME, registered: receipt.marketplace !== undefined },
    plugin: { id: PLUGIN_ID, installed: receipt.plugin_id !== undefined, replaced },
    commands: receipt.commands,
    ...(refused === undefined ? {} : { refused }),
  });

  const step = async (args: string[], done: Partial<Receipt>): Promise<Refusal | undefined> => {
    const ran = await run(args);
    if (ran.code !== 0) return refusal(args, ran);
    receipt = { ...receipt, ...done, commands: [...receipt.commands, args] };
    await writeReceipt(paths, receipt);
    return undefined;
  };

  const added = await step(["plugin", "marketplace", "add", root], {
    marketplace: MARKETPLACE_NAME,
  });
  if (added !== undefined) return so(false, added);

  if (await installed(run)) {
    const args = ["plugin", "uninstall", PLUGIN_ID, "-y"];
    const ran = await run(args);
    if (ran.code !== 0) return so(false, refusal(args, ran));
    replaced = true;
  }

  const put = await step(["plugin", "install", PLUGIN_ID], { plugin_id: PLUGIN_ID });
  return put === undefined ? so(true) : so(false, put);
}

/** What the receipt says was done, beside what is actually there now.
 *
 * Reading it is what tells the two apart: every field the receipt states has
 * the current reading of the same thing beside it, so drift — a file deleted, a
 * marketplace pointed elsewhere, a version other than the one installed — is
 * two fields that differ rather than a sentence about them. */
async function statusClaude(paths: InstancePaths, run: Run = runClaude): Promise<StatusReport> {
  const receipt = await readReceipt(paths, "claude");
  const here = await installedRow(run);
  const registered = await marketplaces(run);
  if (receipt === undefined) {
    // No receipt, so there is nothing of ccmsg's to compare against. A plugin
    // of the same id is still worth naming: it is there, and taking it out is
    // not this command's to do.
    return {
      agent: "claude",
      ok: true,
      marketplace: known(registered, MARKETPLACE_NAME),
      plugin:
        here === undefined
          ? {}
          : { id: PLUGIN_ID, installed_version: here.version, enabled: here.enabled },
    };
  }
  const missing: string[] = [];
  for (const path of receipt.files) {
    if (!(await Bun.file(join(receipt.root, path)).exists())) missing.push(path);
  }
  const market = known(registered, receipt.marketplace, receipt.root);
  return {
    agent: "claude",
    ok: true,
    receipt: receiptFile(paths, "claude"),
    installed_at: receipt.installed_at,
    version: receipt.version,
    config_home: receipt.config_home,
    root: receipt.root,
    files: {
      expected: receipt.files.length,
      present: receipt.files.length - missing.length,
      missing,
    },
    marketplace: market,
    plugin: {
      ...(receipt.plugin_id === undefined ? {} : { id: receipt.plugin_id }),
      ...(here === undefined ? {} : { installed_version: here.version, enabled: here.enabled }),
      expected_version: receipt.version,
    },
  };
}

/** One marketplace as the agent has it, against where it was put.
 *
 * An agent that could not be asked leaves `registered` unsaid, because "we do
 * not know" and "it is not registered" lead to different next steps. */
function known(
  registered: Map<string, string> | undefined,
  name: string | undefined,
  root?: string,
): StatusReport["marketplace"] {
  const named = name === undefined ? {} : { name };
  if (registered === undefined || name === undefined) return named;
  const at = registered.get(name);
  if (at === undefined) return { ...named, registered: false };
  return {
    ...named,
    registered: true,
    ...(root === undefined || at === root || at === "" ? {} : { points_at: at }),
  };
}

/** Undo what the receipt says was done, and nothing else.
 *
 * In the order that leaves nothing dangling: the agent lets go of the plugin,
 * then of the marketplace that offered it, and only then are the files it was
 * reading taken away. A step the receipt does not name is a step that was
 * never taken, so it is not undone. */
async function uninstallClaude(
  paths: InstancePaths,
  run: Run = runClaude,
): Promise<UninstallReport> {
  const receipt = await readReceipt(paths, "claude");
  if (receipt === undefined) return { agent: "claude", ok: true, removed: {} };
  const file = receiptFile(paths, "claude");
  let removed: UninstallReport["removed"] = {};
  if (receipt.plugin_id !== undefined) {
    const args = ["plugin", "uninstall", receipt.plugin_id, "-y"];
    const ran = await run(args);
    if (ran.code !== 0) {
      return { agent: "claude", ok: false, receipt: file, removed, refused: refusal(args, ran) };
    }
    removed = { ...removed, plugin: receipt.plugin_id };
  }
  if (receipt.marketplace !== undefined) {
    const args = ["plugin", "marketplace", "remove", receipt.marketplace];
    const ran = await run(args);
    if (ran.code !== 0) {
      return { agent: "claude", ok: false, receipt: file, removed, refused: refusal(args, ran) };
    }
    removed = { ...removed, marketplace: receipt.marketplace };
  }
  await rm(receipt.root, { recursive: true, force: true });
  await rm(file, { force: true });
  return { agent: "claude", ok: true, receipt: file, removed: { ...removed, root: receipt.root } };
}

/** One installed plugin, as the agent lists it. */
interface Installed {
  readonly version: string;
  readonly enabled: boolean;
}

async function installedRow(run: Run): Promise<Installed | undefined> {
  const ran = await run(["plugin", "list", "--json"]);
  if (ran.code !== 0) return undefined;
  for (const row of rows(ran.stdout)) {
    if (row["id"] !== PLUGIN_ID) continue;
    const version = row["version"];
    return {
      version: typeof version === "string" ? version : "不明",
      enabled: row["enabled"] !== false,
    };
  }
  return undefined;
}

async function installed(run: Run): Promise<boolean> {
  return (await installedRow(run)) !== undefined;
}

/** The marketplaces the agent knows, by name and by where each one points.
 * Nothing when the agent could not be asked, which reads as "unknown" rather
 * than as "none registered". */
async function marketplaces(run: Run): Promise<Map<string, string> | undefined> {
  const ran = await run(["plugin", "marketplace", "list", "--json"]);
  if (ran.code !== 0) return undefined;
  const known = new Map<string, string>();
  for (const row of rows(ran.stdout)) {
    const name = row["name"];
    const path = row["path"] ?? row["installLocation"];
    if (typeof name === "string") known.set(name, typeof path === "string" ? path : "");
  }
  return known;
}

function rows(output: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed.filter(
        (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
      )
    : [];
}

/** A command the agent refused, as the report carries it: what was run, what it
 * exited with, and its first line of complaint. The exit code is stated apart
 * from the words because a command that said nothing still failed. */
function refusal(command: readonly string[], ran: Ran): Refusal {
  return refusalOf("claude", command, ran);
}
