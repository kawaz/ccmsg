import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HARNESSES } from "../harness/index.ts";
import type { InstancePaths } from "../instance/index.ts";

/** The agents ccmsg can install a plugin for, which are the harnesses it
 * speaks to: what is installed is how a session of that harness reaches this
 * instance, so there is one plugin per harness and no third thing to name. */
export const AGENTS = HARNESSES;
export type Agent = (typeof AGENTS)[number];

/** How an agent's own CLI is run. The environment is inherited, which is how
 * the install lands in the config home this instance answers for and not in
 * another one (M6). Named so a test can watch what would be run without a
 * config home of a person's being touched. */
export type Run = (args: readonly string[]) => Promise<Ran>;

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Why one of these commands stopped where it did: the agent command that was
 * refused, and what it said. */
export interface Refusal {
  readonly command: readonly string[];
  readonly code: number;
  readonly said: string;
}

/** A command the agent refused, as the report carries it: what was run, what it
 * exited with, and its first line of complaint. The exit code is stated apart
 * from the words because a command that said nothing still failed. */
export function refusal(binary: string, command: readonly string[], ran: Ran): Refusal {
  const said = `${ran.stderr}${ran.stdout}`.trim();
  return { command: [binary, ...command], code: ran.code, said: said.split("\n")[0] ?? "" };
}

/** What the three commands answer with.
 *
 * Fields rather than sentences: these commands are read by whatever runs them
 * as much as by a person, and a line of prose is something a caller has to
 * parse back into the facts it was built from. The words a person wants are in
 * `--help`; what is here is what was found. */
export interface Report {
  readonly agent: Agent;
  /** Whether the command did everything it set out to do. */
  readonly ok: boolean;
  /** The step that stopped it. Absent while `ok`. */
  readonly refused?: Refusal;
  /** What the agent still needs a person to do before what was installed takes
   * effect. Absent where nothing does. */
  readonly needs?: string;
}

export interface InstallReport extends Report {
  readonly version: string;
  readonly config_home: string;
  readonly root: string;
  /** The files laid down, by their path under `root`. */
  readonly files: readonly string[];
  /** The files laid down elsewhere, by their whole path. What an agent reads
   * out of its own config home rather than out of a plugin's directory goes
   * here, so uninstall takes back exactly what was put there. */
  readonly placed?: readonly string[];
  readonly marketplace?: { readonly name: string; readonly registered: boolean };
  readonly plugin?: {
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
  readonly marketplace?: {
    readonly name?: string;
    /** Whether the agent has it. Absent when the agent could not be asked,
     * which is a different thing from it not being registered. */
    readonly registered?: boolean;
    /** Where the agent thinks it points, when that is not where the receipt
     * put it. */
    readonly points_at?: string;
  };
  readonly plugin?: {
    readonly id?: string;
    /** What the agent reports having, and whether it has it switched on.
     * Present with no `expected_version` beside it means something other than
     * ccmsg installed it. */
    readonly installed_version?: string;
    readonly enabled?: boolean;
    /** What the receipt says should be there. */
    readonly expected_version?: string;
  };
  /** Whether the agent's hooks are switched on at all, where that is a setting
   * of the agent rather than of the plugin. Absent when it could not be asked. */
  readonly hooks_enabled?: boolean;
}

export interface UninstallReport extends Report {
  readonly receipt?: string;
  /** What was actually taken back out. A step the receipt does not name was
   * never taken, so it is not undone and does not appear here. */
  readonly removed: {
    readonly plugin?: string;
    readonly marketplace?: string;
    readonly root?: string;
    readonly placed?: readonly string[];
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
  /** Whole paths written outside that root, in the order they were written. */
  readonly placed?: readonly string[];
  /** The agent commands that were run, as they were run. */
  readonly commands: readonly (readonly string[])[];
  readonly marketplace?: string;
  readonly plugin_id?: string;
}

export function rootFor(paths: InstancePaths, agent: Agent): string {
  return join(paths.pluginsDir, agent);
}

export function receiptFile(paths: InstancePaths, agent: Agent): string {
  return join(paths.pluginsDir, `${agent}.receipt.json`);
}

export async function readReceipt(
  paths: InstancePaths,
  agent: Agent,
): Promise<Receipt | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(receiptFile(paths, agent), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Receipt) : undefined;
  } catch {
    return undefined;
  }
}

export async function writeReceipt(paths: InstancePaths, receipt: Receipt): Promise<void> {
  const file = receiptFile(paths, receipt.agent);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

/** Lay a set of files down, each under the root, in the order given. A string
 * is written as it is; anything else is the content of a JSON file, so the
 * definitions state shapes rather than text and one place turns a value into
 * bytes. */
export async function place(
  root: string,
  files: ReadonlyMap<string, string | object>,
  mode?: number,
): Promise<void> {
  for (const [path, content] of files) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
      mode === undefined ? undefined : { mode },
    );
  }
}
