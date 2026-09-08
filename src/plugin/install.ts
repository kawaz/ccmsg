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

/** What one of these commands did, and what to tell the person who ran it.
 *
 * The report is the result: these commands exist to change something outside
 * ccmsg and to say what they changed, so there is nothing to hand back beyond
 * the account of it and whether it went through. */
export interface Outcome {
  readonly ok: boolean;
  readonly report: readonly string[];
}

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
): Promise<Outcome> {
  const root = rootFor(paths, "claude");
  const files = claudePluginFiles(version);
  const report: string[] = [];
  for (const [path, content] of files) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
  report.push(`プラグインを ${root} に置きました (${files.size} ファイル)`);

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

  const step = async (args: string[], done: Partial<Receipt>): Promise<string | undefined> => {
    const ran = await run(args);
    if (ran.code !== 0) return `claude ${args.join(" ")} が失敗しました: ${failure(ran)}`;
    receipt = { ...receipt, ...done, commands: [...receipt.commands, args] };
    await writeReceipt(paths, receipt);
    return undefined;
  };

  const added = await step(["plugin", "marketplace", "add", root], {
    marketplace: MARKETPLACE_NAME,
  });
  if (added !== undefined) return { ok: false, report: [...report, added] };
  report.push(`marketplace ${MARKETPLACE_NAME} を登録しました`);

  if (await installed(run)) {
    const ran = await run(["plugin", "uninstall", PLUGIN_ID, "-y"]);
    if (ran.code !== 0) {
      return { ok: false, report: [...report, `入れ直しに失敗しました: ${failure(ran)}`] };
    }
    report.push(`既に入っていた ${PLUGIN_ID} を入れ直します`);
  }

  const put = await step(["plugin", "install", PLUGIN_ID], { plugin_id: PLUGIN_ID });
  if (put !== undefined) return { ok: false, report: [...report, put] };
  report.push(`${PLUGIN_ID} を ${paths.configHome} に入れました`);
  report.push("開いているセッションには /reload-plugins で反映されます");
  return { ok: true, report };
}

/** What the receipt says was done, beside what is actually there now. */
export async function status(paths: InstancePaths, run: Run = runClaude): Promise<Outcome> {
  const receipt = await readReceipt(paths, "claude");
  const here = await installedRow(run);
  const registered = await marketplaces(run);
  const report: string[] = [];
  if (receipt === undefined) {
    report.push("claude 用のプラグインは ccmsg からは入れていません");
    if (here !== undefined) {
      report.push(
        `ただし ${PLUGIN_ID} (${here.version}) が入っています — ccmsg 以外が入れたものです`,
      );
    }
    return { ok: true, report };
  }
  report.push(`受領書: ${receiptFile(paths, "claude")}`);
  report.push(`  入れた日時: ${receipt.installed_at} / version ${receipt.version}`);
  report.push(`  置き場所: ${receipt.root}`);
  report.push(`  config home: ${receipt.config_home}`);

  const missing: string[] = [];
  for (const path of receipt.files) {
    if (!(await Bun.file(join(receipt.root, path)).exists())) missing.push(path);
  }
  report.push(
    missing.length === 0
      ? `  ファイル: ${receipt.files.length} 件すべてあります`
      : `  ファイル: ${missing.length} 件ありません (${missing.join(", ")})`,
  );

  const market = registered?.get(receipt.marketplace ?? MARKETPLACE_NAME);
  report.push(
    receipt.marketplace === undefined
      ? "  marketplace: 登録していません"
      : market === undefined
        ? `  marketplace ${receipt.marketplace}: 登録が外れています`
        : market === receipt.root
          ? `  marketplace ${receipt.marketplace}: 登録どおりです`
          : `  marketplace ${receipt.marketplace}: 別の場所を指しています (${market})`,
  );
  report.push(
    receipt.plugin_id === undefined
      ? "  plugin: 入れていません"
      : here === undefined
        ? `  plugin ${receipt.plugin_id}: 入っていません`
        : here.version === receipt.version
          ? `  plugin ${receipt.plugin_id}: ${here.version} が入っています${here.enabled ? "" : " (無効)"}`
          : `  plugin ${receipt.plugin_id}: ${here.version} が入っています (受領書は ${receipt.version})`,
  );
  return { ok: true, report };
}

/** Undo what the receipt says was done, and nothing else.
 *
 * In the order that leaves nothing dangling: the agent lets go of the plugin,
 * then of the marketplace that offered it, and only then are the files it was
 * reading taken away. A step the receipt does not name is a step that was
 * never taken, so it is not undone. */
export async function uninstall(paths: InstancePaths, run: Run = runClaude): Promise<Outcome> {
  const receipt = await readReceipt(paths, "claude");
  if (receipt === undefined) {
    return { ok: true, report: ["ccmsg から入れたものはありません"] };
  }
  const report: string[] = [];
  if (receipt.plugin_id !== undefined) {
    const ran = await run(["plugin", "uninstall", receipt.plugin_id, "-y"]);
    if (ran.code !== 0) {
      return { ok: false, report: [`${receipt.plugin_id} を外せませんでした: ${failure(ran)}`] };
    }
    report.push(`${receipt.plugin_id} を外しました`);
  }
  if (receipt.marketplace !== undefined) {
    const ran = await run(["plugin", "marketplace", "remove", receipt.marketplace]);
    if (ran.code !== 0) {
      return {
        ok: false,
        report: [
          ...report,
          `marketplace ${receipt.marketplace} を外せませんでした: ${failure(ran)}`,
        ],
      };
    }
    report.push(`marketplace ${receipt.marketplace} の登録を外しました`);
  }
  await rm(receipt.root, { recursive: true, force: true });
  report.push(`${receipt.root} を削除しました`);
  await rm(receiptFile(paths, receipt.agent), { force: true });
  return { ok: true, report };
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

/** What to show of a command that did not work: what it said, or its exit code
 * when it said nothing. */
function failure(ran: Ran): string {
  const said = `${ran.stderr}${ran.stdout}`.trim();
  return said === "" ? `終了コード ${ran.code}` : (said.split("\n")[0] ?? "");
}
