import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstancePaths } from "../instance/index.ts";
import { claudePluginFiles, MARKETPLACE_NAME, PLUGIN_ID } from "./claude.ts";

/** The agents ccmsg can install a plugin for. One so far; the word is in the
 * command because the second one is what the shape is for. */
export const AGENTS = ["claude"] as const;
export type Agent = (typeof AGENTS)[number];

/** How the agent's own CLI is run. The environment is inherited, which is how
 * the install lands in the config home this instance answers for and not in
 * another one (M6). Named so a test can watch what would be run without a
 * config home of a person's being touched. */
export type Run = (args: readonly string[]) => Promise<Ran>;

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

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

/** Why one of these commands stopped where it did: the agent command that was
 * refused, and what it said. */
export interface Refusal {
  readonly command: readonly string[];
  readonly code: number;
  readonly said: string;
}

/** What the three commands answer with.
 *
 * Fields rather than sentences: these commands are read by whatever runs them
 * as much as by a person, and a line of prose is something a caller has to
 * parse back into the facts it was built from. The words a person wants are in
 * `--help`; what is here is what was found. */
interface Report {
  readonly agent: Agent;
  /** Whether the command did everything it set out to do. */
  readonly ok: boolean;
  /** The step that stopped it. Absent while `ok`. */
  readonly refused?: Refusal;
}

export interface InstallReport extends Report {
  readonly version: string;
  readonly config_home: string;
  readonly root: string;
  /** The files laid down, by their path under `root`. */
  readonly files: readonly string[];
  readonly marketplace: { readonly name: string; readonly registered: boolean };
  readonly plugin: {
    readonly id: string;
    readonly installed: boolean;
    /** Whether a copy of the same id was taken out first, which is what makes
     * a repeated install run what was just laid down. */
    readonly replaced: boolean;
  };
  /** The agent commands that were run, as they were run. */
  readonly commands: readonly (readonly string[])[];
}

export interface StatusReport extends Report {
  /** Where the receipt is. Absent when ccmsg installed nothing here, which is
   * what makes every field below it absent too. */
  readonly receipt?: string;
  readonly installed_at?: string;
  /** What the receipt says was installed. */
  readonly version?: string;
  readonly config_home?: string;
  readonly root?: string;
  /** The receipt's files, counted against what is under `root` now. */
  readonly files?: {
    readonly expected: number;
    readonly present: number;
    readonly missing: readonly string[];
  };
  readonly marketplace: {
    readonly name?: string;
    /** Whether the agent has it. Absent when the agent could not be asked,
     * which is a different thing from it not being registered. */
    readonly registered?: boolean;
    /** Where the agent thinks it points, when that is not where the receipt
     * put it. */
    readonly points_at?: string;
  };
  readonly plugin: {
    readonly id?: string;
    /** What the agent reports having, and whether it has it switched on.
     * Present with no `expected_version` beside it means something other than
     * ccmsg installed it. */
    readonly installed_version?: string;
    readonly enabled?: boolean;
    /** What the receipt says should be there. */
    readonly expected_version?: string;
  };
}

export interface UninstallReport extends Report {
  readonly receipt?: string;
  /** What was actually taken back out. A step the receipt does not name was
   * never taken, so it is not undone and does not appear here. */
  readonly removed: {
    readonly plugin?: string;
    readonly marketplace?: string;
    readonly root?: string;
  };
}

export type Outcome = InstallReport | StatusReport | UninstallReport;

/** What one install did, so that uninstall can undo exactly that.
 *
 * Everything reversible is written down before the next step is taken: the
 * files that were laid down, the commands that were run against the agent, and
 * the id the agent now knows the plugin by. Undoing reads this and nothing
 * else — an install that half-finished leaves a receipt for the half that
 * happened, and a plugin somebody else installed is not in it and is left
 * alone. */
export interface Receipt {
  readonly agent: Agent;
  readonly version: string;
  readonly installed_at: string;
  /** The config home the agent was asked to install into. */
  readonly config_home: string;
  /** Where the plugin's own files were laid down. */
  readonly root: string;
  /** Their paths under that root, in the order they were written. */
  readonly files: readonly string[];
  /** The agent commands that were run, as they were run. */
  readonly commands: readonly (readonly string[])[];
  readonly marketplace?: string;
  readonly plugin_id?: string;
}

function rootFor(paths: InstancePaths, agent: Agent): string {
  return join(paths.pluginsDir, agent);
}

function receiptFile(paths: InstancePaths, agent: Agent): string {
  return join(paths.pluginsDir, `${agent}.receipt.json`);
}

async function readReceipt(paths: InstancePaths, agent: Agent): Promise<Receipt | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(receiptFile(paths, agent), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Receipt) : undefined;
  } catch {
    return undefined;
  }
}

async function writeReceipt(paths: InstancePaths, receipt: Receipt): Promise<void> {
  const file = receiptFile(paths, receipt.agent);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
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
export async function install(
  paths: InstancePaths,
  version: string,
  run: Run = runClaude,
): Promise<InstallReport> {
  const root = rootFor(paths, "claude");
  const files = claudePluginFiles(version);
  for (const [path, content] of files) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }

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
export async function status(paths: InstancePaths, run: Run = runClaude): Promise<StatusReport> {
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
export async function uninstall(
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
  const said = `${ran.stderr}${ran.stdout}`.trim();
  return { command: ["claude", ...command], code: ran.code, said: said.split("\n")[0] ?? "" };
}
