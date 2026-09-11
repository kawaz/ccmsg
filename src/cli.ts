#!/usr/bin/env bun
import {
  type MessageSendArgs,
  type NotifySendArgs,
  PROTOCOL_VERSION,
  type SessionDumpFile,
  type SessionDumpWriteArgs,
  type SessionDumpWriteResult,
} from "@ccmsg/protocol";
import {
  add as addToConfig,
  ask,
  type CliErrorCode,
  CommandError,
  configHome,
  connect,
  expectedInstances,
  follow,
  harnessFor,
  idOf,
  labelled,
  list as listInstances,
  reachable,
  registered,
  remove as removeFromConfig,
  rowFor,
  snapshots,
  type SuperviseOp,
  Supervisor,
  tailOf,
  type Target,
  targetFor,
} from "./daemon/index.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { document } from "./transcript/items/index.ts";
import { currentSession, DEFAULT_HARNESS, HARNESS, HARNESSES, isHarness } from "./harness/index.ts";

/** The variables a session is named by, for the help and for the message a
 * command answers with when it finds none of them. */
const SESSION_ENV = HARNESSES.flatMap((harness) => [...HARNESS[harness].sessionEnv]);
import { hookEvent, type StatedMeta, statedMeta } from "./greeting/index.ts";
import {
  isRunning,
  MERGE_RULES,
  resolveConfigHome,
  resolvePaths,
  resolvePathsFor,
  start,
} from "./instance/index.ts";

/** The merge rules as the help prints them: one line per field path, in the
 * order the schema declares them, so the table a person reads is the table the
 * merge runs on. */
const MERGE_DOCS: readonly Doc[] = Object.entries(MERGE_RULES).map(([path, rule]) => [
  path,
  rule === "merge"
    ? "instances[] 側にある field だけを defaults に重ねる"
    : "instances[] 側にあれば丸ごと置換する (追加・和にはならない)",
]);
import {
  type Agent,
  AGENTS,
  install,
  type Outcome,
  status as pluginStatus,
  uninstall,
} from "./plugin/index.ts";
import { type Run, runCommand, serviceFor } from "./service/index.ts";
import { VERSION } from "./version.ts";

/** The session this process runs inside, as its environment says (§3.8).
 *
 * One reading for every command that speaks as a session: which harness
 * claimed the process settles both who the sender is and which instance it
 * reaches, and a command that took the two from different places could greet
 * one instance as a session of the other. */
function ownSid(): string | undefined {
  return currentSession(process.env)?.sid;
}

/** Where a hook event is read from. Named for the same reason a speech binary
 * is: a test drives the two commands a harness fires without a standard input
 * of its own to write to. */
export type Read = () => Promise<string>;

/** The system speech binary. Absolute on purpose: a `say` shim earlier on PATH
 * is what delegates here, so resolving through PATH again would re-enter the
 * shim. */
const SYSTEM_SAY = "/usr/bin/say";

/** What every command may be given, and what every command reads from.
 *
 * `-h` / `--help` is the one option no level defines for itself: asking a
 * command what it does is the same question at every level, and answering it
 * where the tree is walked rather than inside each command is what keeps the
 * answer the same. */
const GLOBAL_OPTIONS: readonly Doc[] = [["-h, --help", "そのレベルのヘルプを表示する"]];

const GLOBAL_ENV: readonly Doc[] = [
  ["CLAUDE_CONFIG_DIR", "この CLI が話す instance の config home (既定は ~/.claude)"],
  ["CCMSG_CONFIG_DIR", "共通 config の置き場 (既定は XDG_CONFIG_HOME/ccmsg)"],
  ["CCMSG_STATE_DIR", "state・socket・pid・ログの置き場 (既定は XDG_STATE_HOME/ccmsg)"],
];

/** A name and what it is, as the help prints it. */
type Doc = readonly [string, string];

/** One command in the tree.
 *
 * `run` answers with what the command found, and printing it is not its
 * business: every command that is not `--help` answers in JSON, so there is one
 * place that writes it and no command that can forget to. */
interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly options?: readonly Doc[];
  readonly env?: readonly Doc[];
  /** Anything else this level has to state as a list of names, under a title of
   * its own. Options and environment are the two every level shares; this is
   * for what only one of them has. */
  readonly notes?: readonly { readonly title: string; readonly docs: readonly Doc[] }[];
  readonly children?: readonly Command[];
  readonly run?: (args: readonly string[]) => Promise<unknown>;
  /** Whether running it with nothing after it is a command rather than a
   * question. A level that leads somewhere answers "no arguments" with the help
   * — there is nothing else it could mean — and so does a command whose
   * arguments are required. This marks the rest: `daemon list` and
   * `service status` take nothing, and printing their help instead of their
   * answer would make them unreachable. */
  readonly bare?: boolean;
  /** A command that takes its arguments over rather than parsing them, which
   * is what `say` is: its arguments belong to another program. */
  readonly raw?: (args: readonly string[]) => Promise<number>;
}

/** The whole CLI, as the tree the help prints and the dispatch walks. */
const ROOT: Command = {
  name: "ccmsg",
  summary: "config home ごとの instance と、セッションからの一行",
  usage: "ccmsg <command> [subcommand] [options] [--] [args...]",
  children: [
    {
      name: "daemon",
      summary: "instance の起動・停止・状態",
      usage: "ccmsg daemon <subcommand> [options]",
      options: [["--all", "登録されている instance すべてを対象にする"]],
      children: [
        {
          name: "run",
          summary: "この config home の instance を foreground で起動する (監督者の管理外)",
          usage: "ccmsg daemon run [dir]",
          bare: true,
          run: (args) => runInstance(args[0]),
        },
        {
          name: "supervise",
          summary: "共通 config の instance を子プロセスとして起動し、落ちたら上げる",
          usage: "ccmsg daemon supervise",
          bare: true,
          run: () => supervise(),
        },
        {
          name: "add",
          summary: "共通 config の instances[] に足し、監督者が居れば起こさせる",
          usage: "ccmsg daemon add <dir> [--harness <種別>]",
          options: [
            [
              "--harness <種別>",
              `config home が動かすもの: ${HARNESSES.join(" | ")} (既定 ${DEFAULT_HARNESS})`,
            ],
          ],
          notes: [
            {
              title:
                "共通 config で instances[] の値が defaults に重なる規則 (掲載の無いパスは丸ごと置換):",
              docs: MERGE_DOCS,
            },
          ],
          run: (args) => added(args),
        },
        {
          name: "remove",
          summary: "instances[] から外す (監督者は以後見ないが、子は止めない)",
          usage: "ccmsg daemon remove <dir>",
          run: (args) => removed(args[0]),
        },
        {
          name: "list",
          summary: "登録されている config home と、動いているかを並べる",
          usage: "ccmsg daemon list",
          bare: true,
          run: () => Promise.resolve(listInstances(process.env)),
        },
        {
          name: "start",
          summary: "監督者に、この config home の子を起こさせる",
          usage: "ccmsg daemon start <dir> | --all",
          run: (args) => supervised("supervise_start", args),
        },
        {
          name: "stop",
          summary: "監督者に、子を止めさせる (instance.shutdown、以後は上げ直さない)",
          usage: "ccmsg daemon stop <dir> | --all",
          run: (args) => supervised("supervise_stop", args),
        },
        {
          name: "restart",
          summary: "監督者に、止めてから起こし直させる",
          usage: "ccmsg daemon restart <dir> | --all",
          run: (args) => supervised("supervise_restart", args),
        },
        {
          name: "status",
          summary: "監督者が各子に instance.ping して version・network・peers を答える",
          usage: "ccmsg daemon status [dir] | --all",
          bare: true,
          run: (args) => supervised("supervise_status", args, true),
        },
        {
          name: "passkey",
          summary: "この config home の instance に登録された passkey を扱う",
          usage: "ccmsg daemon passkey <subcommand>",
          children: [
            {
              name: "add",
              summary: "登録用 URL と 6 桁コードを 1 組発行する (10 分で失効)",
              usage: "ccmsg daemon passkey add <unit> [endpoint] [--name <ラベル>]",
              options: [
                [
                  "[endpoint]",
                  "登録先の公開 base URL (末尾 /)。既定はこの instance が確定した endpoint",
                ],
                ["--name <ラベル>", "誰宛に発行した URL かの管理ラベル"],
              ],
              run: (args) => passkeyAdd(args),
            },
            {
              name: "list",
              summary: "登録済みの credential を、新しい順に並べる",
              usage: "ccmsg daemon passkey list [unit]",
              bare: true,
              run: (args) => passkeyAsk(args[0], { admin: "passkey_list" }),
            },
            {
              name: "remove",
              summary: "利用者を消す (credential と token を失効させ、その WS を切る)",
              usage: "ccmsg daemon passkey remove <sub> [unit]",
              run: (args) => passkeyRemove(args),
            },
          ],
        },
        {
          name: "log",
          summary: "instance の daemon.log を出す (--all は行に id を足して多重化)",
          usage: "ccmsg daemon log [dir] | --all [--follow]",
          options: [["--follow", "書き足される行を待ち続ける (Ctrl-C で終わり)"]],
          bare: true,
          run: (args) => daemonLog(args),
        },
      ],
    },
    {
      name: "service",
      summary: "監督者 (ccmsg daemon supervise) を launchd / systemd に登録する",
      usage: "ccmsg service <subcommand>",
      children: [
        {
          name: "register",
          summary: "監督者をこのホストの init system に登録する",
          usage: "ccmsg service register",
          bare: true,
          run: () => serviceOp("register"),
        },
        {
          name: "unregister",
          summary: "登録を外し、置いた定義ファイルを消す",
          usage: "ccmsg service unregister",
          bare: true,
          run: () => serviceOp("unregister"),
        },
        {
          name: "start",
          summary: "監督者を起動する",
          usage: "ccmsg service start",
          bare: true,
          run: () => serviceOp("start"),
        },
        {
          name: "stop",
          summary: "監督者を停止する",
          usage: "ccmsg service stop",
          bare: true,
          run: () => serviceOp("stop"),
        },
        {
          name: "status",
          summary: "登録の有無・監督者の pid・init system 側の状態・見ている instance",
          usage: "ccmsg service status",
          bare: true,
          run: () => serviceOp("status"),
        },
        {
          name: "log",
          summary: "監督者と init system 側のログを出す",
          usage: "ccmsg service log [--follow]",
          options: [["--follow", "書き足される行を待ち続ける (Ctrl-C で終わり)"]],
          bare: true,
          run: (args) => serviceLog(args),
        },
      ],
    },
    {
      name: "plugin",
      summary: "エージェントへ ccmsg のプラグインを入れる",
      usage: "ccmsg plugin <subcommand> [<agent>]",
      env: [["", `エージェント: ${AGENTS.join(", ")}`]],
      children: [
        {
          name: "install",
          summary: "そのエージェントに ccmsg のプラグインを入れる",
          usage: "ccmsg plugin install <agent>",
          options: [
            ["claude", "開いているセッションには /reload-plugins で反映される"],
            ["codex", "config home に直接置く。hook は codex 側で trust してから効く"],
          ],
          run: (args) => plugin("install", args[0]),
        },
        {
          name: "status",
          summary: "入れたものと今の状態を見比べる",
          usage: "ccmsg plugin status [<agent>]",
          run: (args) => plugin("status", args[0]),
        },
        {
          name: "uninstall",
          summary: "入れたものだけを元に戻す",
          usage: "ccmsg plugin uninstall <agent>",
          run: (args) => plugin("uninstall", args[0]),
        },
      ],
    },
    {
      name: "peers",
      summary: "instance が知っているセッションを並べる (相手の sid を探す)",
      usage: "ccmsg peers [--all]",
      bare: true,
      options: [
        ["--all", "mesh 越しの instance が言っている分も含める"],
        ["--json", "JSON で答える (既定、この CLI は常に JSON で答える)"],
        ["--sid <sid>", `自分のセッション ID (既定は ${SESSION_ENV.join(" / ")})`],
      ],
      env: sessionEnv(),
      run: (args) => peers(args),
    },
    {
      name: "agents",
      summary: "harness 自身が見ているセッションを並べる (繋いでいないものも含む)",
      usage: "ccmsg agents [--all]",
      bare: true,
      options: [
        ["--all", "mesh 越しの instance が言っている分も含める"],
        ["--json", "JSON で答える (既定、この CLI は常に JSON で答える)"],
      ],
      run: (args) => agents(args),
    },
    {
      name: "dump",
      summary: "セッション (か配下の worker 1 体) の transcript を型ごとの表示で書き出す",
      usage: "ccmsg dump <sid>[/agent-<id>] [--preset <名前>] [--types <選択>]",
      options: [
        ["--preset <名前>", "instance が持つ選択 (ccmsg dump presets で一覧)"],
        ["--types <選択>", "型をカンマ区切りで。prefix 可、-で除外、@名前で preset 展開"],
        ["--since <at|uuid>", "下限。時刻 (ISO か epoch ミリ秒) か record の uuid"],
        ["--until <at|uuid>", "上限。同上"],
        ["--max-chars <n>", "1 アイテムの本文をこの文字数で切る (既定は切らない)"],
        ["--json", "markdown ではなく dump file の中身をそのまま出す"],
        ["--out <path>", "標準出力ではなくこの path に書く"],
      ],
      notes: [
        {
          title: "別のセッションのやり方を読む:",
          docs: [
            ["1", "ccmsg dump <sid> --preset howto で親を読む"],
            ["2", "末尾の ids 台帳から良さそうな worker の agent id を選ぶ"],
            ["3", "ccmsg dump <sid>/agent-<id> --preset howto で主語を移して掘る"],
          ],
        },
      ],
      children: [
        {
          name: "presets",
          summary: "この instance が持つ preset の名前と中身を並べる",
          usage: "ccmsg dump presets",
          bare: true,
          run: () => instanceAsk({ op: "dump.presets.read" }),
        },
      ],
      run: (args) => dump(args),
    },
    {
      name: "post",
      summary: "別のセッションへメッセージを送る",
      usage: "ccmsg post <sid> <text> [--sid <自分の sid>]",
      options: [["--sid <sid>", `自分のセッション ID (既定は ${SESSION_ENV.join(" / ")})`]],
      env: sessionEnv(),
      run: (args) => post(args),
    },
    {
      name: "reply",
      summary: "受け取ったメッセージに返信する",
      usage: "ccmsg reply <mid> <text> [--to <相手の sid>]",
      options: [
        ["--sid <sid>", `自分のセッション ID (既定は ${SESSION_ENV.join(" / ")})`],
        ["--to <sid>", "宛先セッション (封筒の ccmsg-from)。省略すると人への返信"],
      ],
      env: sessionEnv(),
      run: (args) => reply(args),
    },
    {
      name: "notify",
      summary: "見ている人へ一行知らせる (保持されない、返事も来ない)",
      usage: "ccmsg notify <text> [--about <sid>]",
      options: [
        ["--sid <sid>", `自分のセッション ID (既定は ${SESSION_ENV.join(" / ")})`],
        ["--about <sid>", "知らせるセッション (既定は自分)"],
      ],
      env: sessionEnv(),
      run: (args) => notify(args),
    },
    {
      name: "stopping",
      summary: "これから終わると instance に伝える (以後は Paused 扱い)",
      usage: "ccmsg stopping [--reason <text>] [--hook]",
      bare: true,
      options: [
        ["--sid <sid>", `自分のセッション ID (既定は ${SESSION_ENV.join(" / ")})`],
        ["--reason <text>", "終わる理由 (表示用、任意)"],
        ["--hook", "harness の hook イベント JSON を標準入力から読む"],
      ],
      env: sessionEnv(),
      run: (args) => stopping(args),
    },
    {
      name: "hello",
      summary: "自分がどこで動いているかを instance に名乗る",
      usage: "ccmsg hello [--cwd <path>] [--repo <name>] ... [--hook]",
      bare: true,
      options: [
        ["--sid <sid>", `自分のセッション ID (既定は ${SESSION_ENV.join(" / ")})`],
        ["--cwd <path>", "作業ディレクトリ"],
        ["--repo <name>", "リポジトリの表示名"],
        ["--ws <name>", "ワークスペース名"],
        ["--repo-root <path>", "リポジトリの入れ物"],
        ["--branch <name>", "チェックアウト中のブランチ"],
        ["--transcript-path <path>", "会話の記録"],
        ["--title <text>", "セッションの題"],
        ["--hook", "harness の hook イベント JSON を標準入力から読む"],
      ],
      env: sessionEnv(),
      run: (args) => hello(args),
    },
    {
      name: "say",
      summary: `${SYSTEM_SAY} で発声し、どのセッションが喋ったかを知らせる`,
      usage: "ccmsg say [say-options] [text...]",
      options: [["", `引数は ${SYSTEM_SAY} へそのまま渡す (単独の --help だけが例外)`]],
      env: [
        [SESSION_ENV.join(" / "), "喋ったセッションの名乗り"],
        ["CCMSG_SAY_BIN", `発声に使うバイナリ (既定は ${SYSTEM_SAY})`],
      ],
      raw: (args) => say(args),
    },
  ],
};

function sessionEnv(): readonly Doc[] {
  return [[SESSION_ENV.join(" / "), "自分のセッション ID"]];
}

/** Walk the tree, and answer at the level the arguments reach.
 *
 * No arguments is the help at every level, which is why the walk checks it
 * before it checks anything else: a command that was named without being told
 * what to do has nothing to answer but what it can be told. */
export async function main(argv: readonly string[]): Promise<number> {
  const path: Command[] = [ROOT];
  let rest = argv;
  for (;;) {
    const at = path[path.length - 1] as Command;
    if (at.raw !== undefined) {
      return await at.raw(rest);
    }
    const asked = rest[0] === "-h" || rest[0] === "--help";
    if (asked || (rest.length === 0 && at.bare !== true)) {
      process.stdout.write(help(path));
      return asked || at.run === undefined ? 0 : 2;
    }
    const child = at.children?.find((one) => one.name === rest[0]);
    if (child !== undefined) {
      path.push(child);
      rest = rest.slice(1);
      continue;
    }
    if (at.run === undefined) {
      const word = rest[0] as string;
      process.stderr.write(`${help(path)}\n`);
      return report(new CommandError("bad_request", `知らないサブコマンドです: ${word}`));
    }
    try {
      emit(await at.run(rest));
      return 0;
    } catch (cause) {
      return report(cause);
    }
  }
}

/** Everything a command answers, as one JSON document. */
function emit(value: unknown): void {
  if (value === undefined) return;
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Everything a command refuses, in the contract's error shape. */
function report(cause: unknown): number {
  const error =
    cause instanceof CommandError
      ? {
          code: cause.code,
          msg: cause.message,
          ...(cause.detail === undefined ? {} : { detail: cause.detail }),
        }
      : { code: "internal_error", msg: String(cause) };
  process.stderr.write(`${JSON.stringify({ error }, null, 2)}\n`);
  return 1;
}

/** The help for one level: its subcommands, its own options, the global ones,
 * and the environment either it or the whole CLI reads. */
function help(path: readonly Command[]): string {
  const at = path[path.length - 1] as Command;
  const name = path.map((one) => one.name).join(" ");
  const lines = [`${name} — ${at.summary}`, ""];
  lines.push("使い方:", `  ${at.usage ?? name}`, "");
  if (at.children !== undefined) {
    lines.push("サブコマンド:");
    const width = Math.max(...at.children.map((one) => one.name.length));
    for (const child of at.children) {
      lines.push(`  ${child.name.padEnd(width)}  ${child.summary}`);
    }
    lines.push("");
  }
  for (const note of at.notes ?? []) section(lines, note.title, note.docs);
  section(lines, "このレベルのオプション:", at.options);
  section(lines, "グローバルオプション:", GLOBAL_OPTIONS);
  section(lines, "環境変数:", [...(at.env ?? []), ...GLOBAL_ENV]);
  return `${lines.join("\n").trimEnd()}\n`;
}

function section(lines: string[], title: string, docs: readonly Doc[] | undefined): void {
  if (docs === undefined || docs.length === 0) return;
  lines.push(title);
  const width = Math.max(...docs.map(([label]) => label.length));
  for (const [label, text] of docs) lines.push(`  ${label.padEnd(width)}  ${text}`);
  lines.push("");
}

/** `ccmsg daemon run [dir]`: this config home's instance, in the foreground. */
async function runInstance(dir: string | undefined): Promise<unknown> {
  const named = dir ?? resolveConfigHome();
  const home = configHome(named, harnessFor(process.env, named));
  // The directory is handed over rather than put in the environment: the
  // instance would otherwise read it back through the question "which session
  // is this process inside", and a `daemon run` issued from a session of
  // another harness would answer for that session's config home (§3.8).
  const outcome = await start({ configHome: home });
  if (!isRunning(outcome)) {
    throw new CommandError(
      "file_exists",
      `${home} の instance は既に動いています (pid ${String(outcome.pid)})`,
    );
  }
  const instance = outcome;
  // A signal is a request to leave, and leaving is the ordered shutdown of
  // §8.5 — the same one `instance.shutdown` runs, so a client sees the same
  // departure either way. The listeners are removed once it has run, because a
  // signal listener keeps the event loop alive and the process would sit at an
  // empty loop instead of exiting.
  const signals = ["SIGINT", "SIGTERM"] as const;
  const asked = (): void => {
    void instance.stop();
  };
  for (const signal of signals) process.on(signal, asked);
  await instance.whenStopped();
  for (const signal of signals) process.off(signal, asked);
  return { dir: home, instance: instance.self, ran: true };
}

/** `ccmsg daemon supervise`: the instances the shared config lists, kept up. */
async function supervise(): Promise<unknown> {
  const supervisor = new Supervisor();
  const signals = ["SIGINT", "SIGTERM"] as const;
  const asked = (): void => {
    void supervisor.stop();
  };
  for (const signal of signals) process.on(signal, asked);
  await supervisor.run();
  for (const signal of signals) process.off(signal, asked);
  return { supervised: supervisor.targets.map((target) => target.dir) };
}

/** `ccmsg daemon add <dir>`: write it down, and have it started.
 *
 * The file first and the supervisor second, because the file is what survives:
 * a host with no supervisor running still gets the config home added, and the
 * next supervisor starts it. Told rather than left to be discovered, because
 * the supervisor reads the list once (DV-Q8) and would otherwise not know
 * until it is restarted. */
async function added(args: readonly string[]): Promise<unknown> {
  const { named, rest } = options(args, ["harness"]);
  const dir = rest[0];
  const stated = named.get("harness");
  if (dir === undefined) {
    throw new CommandError("invalid_args", "使い方: ccmsg daemon add <dir> [--harness <種別>]");
  }
  if (stated !== undefined && !isHarness(stated)) {
    throw new CommandError("invalid_args", `--harness は ${HARNESSES.join(" | ")} のどれかです`);
  }
  const row = addToConfig(process.env, dir, stated ?? DEFAULT_HARNESS);
  if (!(await reachable())) return { ...row, supervised: false };
  const started = (await ask({ op: "supervise_add", dir: row.dir })) as Record<string, unknown>;
  return { ...started, supervised: true };
}

/** `ccmsg daemon remove <dir>`: take it off the list, and stop looking after it.
 *
 * The instance itself is left alone: a list edit is not a shutdown, and a
 * session already talking to that instance keeps it. `daemon stop` is how one
 * is stopped, and keeping the two apart is what makes that true. */
async function removed(dir: string | undefined): Promise<unknown> {
  if (dir === undefined) {
    throw new CommandError("invalid_args", "使い方: ccmsg daemon remove <dir>");
  }
  const row = removeFromConfig(process.env, dir);
  if (!(await reachable())) return { ...row, supervised: false };
  await ask({ op: "supervise_remove", dir: row.dir });
  return { ...row, supervised: false };
}

/** The four commands that are requests to the supervisor rather than things
 * this process does.
 *
 * They are its business because it is the one that holds the children: a second
 * route that started an instance behind the supervisor's back would produce an
 * instance nothing restarts and nothing knows about. With no supervisor there
 * is nobody to ask, which is what the caller is told. */
async function supervised(
  op: SuperviseOp,
  args: readonly string[],
  hereByDefault = false,
): Promise<unknown> {
  const parsed = options(args, [], ["all"]);
  const all = parsed.flags.has("all");
  const named = parsed.rest[0];
  if (all && named !== undefined) {
    throw new CommandError("invalid_args", "--all と dir は同時に指定できません");
  }
  if (all) return await ask({ op, all: true });
  const dir = named ?? (hereByDefault ? resolveConfigHome() : undefined);
  if (dir === undefined) throw new CommandError("invalid_args", "dir か --all が要ります");
  return await ask({ op, dir });
}

/** `ccmsg service <what>`: the supervisor's registration with the host. */
async function serviceOp(
  what: "register" | "unregister" | "start" | "stop" | "status",
  run: Run = runCommand,
): Promise<unknown> {
  const service = serviceFor();
  if (what === "unregister") return { kind: service.kind, ...(await service.unregister(run)) };
  const state =
    what === "register"
      ? await service.register(run)
      : what === "start"
        ? await service.start(run)
        : what === "stop"
          ? await service.stop(run)
          : await service.state(run);
  if (what !== "status") return { kind: service.kind, unit: service.unitFile, ...state };
  return {
    kind: service.kind,
    unit: service.unitFile,
    ...state,
    instances: registered(process.env).map((target) => {
      const row = rowFor(target);
      return { id: row.id, dir: row.dir, running: row.running };
    }),
  };
}

/** The passkey commands, which are asked of the instance itself rather than of
 * the supervisor.
 *
 * They travel on the instance's unix socket and nowhere else: registration is
 * local by design (DR-0001 §2.2), and reaching that address is what says the
 * caller is on the machine. They are not ops of the contract for the same
 * reason — the contract is what reaches an instance over a network. */
async function passkeyAsk(unit: string | undefined, request: Record<string, unknown>) {
  const target = targetFor(process.env, unit ?? resolveConfigHome());
  const conn = await connect(target.paths.socket);
  if (conn === undefined) {
    throw new CommandError("not_found", `${target.dir} の instance は動いていません`);
  }
  try {
    const answer = await conn.ask(request);
    if (answer["ok"] === true) {
      const { ok: _ok, request_id: _id, ...body } = answer;
      return body;
    }
    const error = answer["error"] as { code?: CliErrorCode; msg?: string } | undefined;
    throw new CommandError(error?.code ?? "internal_error", error?.msg ?? JSON.stringify(answer));
  } finally {
    conn.close();
  }
}

/** `ccmsg daemon passkey add`: one registration URL, and the code that goes
 * with it.
 *
 * Both are printed here and the code is nowhere else — not in the URL, not in
 * anything the instance hands out — so that holding the URL is not enough to
 * register (DR-0001 §2.2). */
async function passkeyAdd(args: readonly string[]): Promise<unknown> {
  const parsed = options(args, ["name"]);
  const [unit, endpoint] = parsed.rest;
  if (unit === undefined) {
    throw new CommandError(
      "invalid_args",
      "使い方: ccmsg daemon passkey add <unit> [endpoint] [--name <ラベル>]",
    );
  }
  const name = parsed.named.get("name");
  return await passkeyAsk(unit, {
    admin: "passkey_add",
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(name === undefined ? {} : { name }),
  });
}

async function passkeyRemove(args: readonly string[]): Promise<unknown> {
  const [sub, unit] = args;
  if (sub === undefined) {
    throw new CommandError("invalid_args", "使い方: ccmsg daemon passkey remove <sub> [unit]");
  }
  return await passkeyAsk(unit, { admin: "passkey_remove", sub });
}

/** `ccmsg daemon log`: what one instance wrote down, or what all of them did.
 *
 * JSON lines rather than one document, because a log is a stream and `--follow`
 * has no end to close a document at. Over `--all` each line carries the
 * instance it came from, which is the whole of what multiplexing needs: the
 * lines are already JSON objects, so the label goes beside their fields. */
async function daemonLog(args: readonly string[]): Promise<undefined> {
  const parsed = options(args, [], ["follow", "all"]);
  const following = parsed.flags.has("follow");
  // The label follows `--all` rather than how many config homes happen to be
  // registered: a reader that asked for every instance's log gets the same
  // shape whether the host runs one or five.
  const many = parsed.flags.has("all");
  const targets = many
    ? registered(process.env)
    : [targetFor(process.env, parsed.rest[0] ?? resolveConfigHome())];
  const write = (target: Target, lines: readonly string[]): void => {
    for (const line of lines) {
      process.stdout.write(
        `${many ? labelled(line, { id: idOf(target), dir: target.dir }) : line}\n`,
      );
    }
  };
  const followers: { close(): void }[] = [];
  for (const target of targets) {
    const file = join(target.paths.stateDir, "daemon.log");
    const read = await tailOf(file);
    write(target, read.lines);
    if (following)
      followers.push(follow(file, read.end, (lines: readonly string[]) => write(target, lines)));
  }
  if (following) await never(() => followers.forEach((one) => one.close()));
  return undefined;
}

/** `ccmsg service log`: what the supervisor said, and what the init system says
 * about the last time it ran. */
async function serviceLog(args: readonly string[], run: Run = runCommand): Promise<undefined> {
  const parsed = options(args, [], ["follow"]);
  const following = parsed.flags.has("follow");
  const service = serviceFor();
  // What the init system knows is one line at the top rather than a section:
  // whether it is loaded, running and what it last exited with is the context
  // the lines below are read in.
  const state = await service.state(run);
  process.stdout.write(`${JSON.stringify({ unit: service.unitFile, ...state })}\n`);
  const source = service.logSource();
  if (source.kind === "command") {
    const command = following ? source.follow : source.show;
    return await Bun.spawn(command, { stdout: "inherit", stderr: "inherit" }).exited.then(
      () => undefined,
    );
  }
  const read = await tailOf(source.file);
  for (const line of read.lines) process.stdout.write(`${line}\n`);
  if (!following) return undefined;
  const follower = follow(source.file, read.end, (lines: readonly string[]) => {
    for (const line of lines) process.stdout.write(`${line}\n`);
  });
  await never(() => {
    follower.close();
  });
  return undefined;
}

/** Run until the terminal takes the command away, which is what `--follow`
 * means: there is no last line to stop at, so what ends it is a signal. */
function never(release: () => void): Promise<void> {
  return new Promise((resolve) => {
    const leave = (): void => {
      release();
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, leave);
      resolve();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, leave);
  });
}

/** `ccmsg peers`: the sessions this instance holds, and the ones it has lost.
 *
 * The command a session runs to find out who else is there: a `post` needs the
 * other session's sid, and nothing else states one. It greets as the session it
 * runs inside when it knows which that is, because one field of the answer is
 * computed against the asker — `send_message` says whether the harness's own
 * messaging reaches that peer, and there is nobody to compare against for a
 * greeting that named no session. Without a sid it asks as a person, which is
 * the same list minus that field. */
function peers(args: readonly string[]): Promise<unknown> {
  const parsed = options(args, ["sid"], ["all", "json"]);
  const sid = parsed.named.get("sid") ?? ownSid();
  return topic(
    "peers",
    parsed.flags.has("all"),
    sid === undefined || sid === ""
      ? { op: "hello.user", protocol_version: PROTOCOL_VERSION }
      : { op: "hello.session", sid, protocol_version: PROTOCOL_VERSION, ...statedMeta() },
  );
}

/** `ccmsg agents`: the harness's own view, which covers sessions that never
 * connected here. Asked as a person, because that is who the topic is open to:
 * it names processes and config homes rather than anything one session is a
 * party to. */
function agents(args: readonly string[]): Promise<unknown> {
  const parsed = options(args, [], ["all", "json"]);
  return topic("agents", parsed.flags.has("all"), {
    op: "hello.user",
    protocol_version: PROTOCOL_VERSION,
  });
}

/** Read the current value of a cluster topic and answer with it.
 *
 * One entry per instance, carrying the topic's payload exactly as the contract
 * defines it: a whole value per instance is not something to merge into one
 * list, since two instances' entries stand side by side and only the frame says
 * whose is whose. */
async function topic(
  name: "peers" | "agents",
  all: boolean,
  greeting: Record<string, unknown>,
): Promise<unknown> {
  const paths = resolvePaths();
  const conn = await connect(paths.socket);
  if (conn === undefined) {
    throw new CommandError(
      "instance_unreachable",
      `${paths.socket} に繋がりません (instance は動いていません)`,
    );
  }
  try {
    const greeted = await conn.ask(greeting);
    if (greeted["ok"] !== true) {
      throw new CommandError("forbidden", `hello が拒否されました: ${JSON.stringify(greeted)}`);
    }
    return await snapshots(conn, name, expectedInstances(greeted, all));
  } finally {
    conn.close();
  }
}

/** `ccmsg dump <sid>[/agent-<id>]`: read how a session worked.
 *
 * The instance writes the file — it is the one that can read a transcript, and
 * a path that outlives the request is the point of the op — and this reads it
 * back and draws it. Which means the two halves stay where they belong: what
 * an item is settled by whoever read the file, and how an item reads is
 * settled here, where somebody is looking at it.
 *
 * `--json` hands over the file as it stands, for a reader that is a program. */
async function dump(args: readonly string[]): Promise<unknown> {
  const parsed = options(args, ["preset", "types", "since", "until", "out", "max-chars"], ["json"]);
  const subject = parsed.rest[0];
  if (subject === undefined) {
    throw new CommandError(
      "invalid_args",
      "使い方: ccmsg dump <sid>[/agent-<id>] [--preset <名前>] [--types <選択>]",
    );
  }
  const written = (await instanceAsk({
    op: "session.dump.write",
    ...dumpArgs(subject, parsed.named),
  })) as unknown as SessionDumpWriteResult;
  const body = readFileSync(written.path, "utf8");
  const since = parsed.named.get("since");
  const until = parsed.named.get("until");
  const limit = parsed.named.get("max-chars");
  const text = parsed.flags.has("json")
    ? body
    : document(JSON.parse(body) as SessionDumpFile, {
        instance: written.instance,
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        ...(limit === undefined ? {} : { max_chars: chars(limit) }),
      });
  const out = parsed.named.get("out");
  if (out === undefined) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return undefined;
  }
  writeFileSync(out, text);
  return {
    path: out,
    bytes: Buffer.byteLength(text),
    dump: written.path,
    instance: written.instance,
    entries: written.entries,
    ids: written.ids,
  };
}

/** What a person typed, as the op's arguments.
 *
 * `<sid>/agent-<id>` is split here and nowhere else: the contract keeps the
 * two apart so that a sid stays a validated sid, and the joined spelling is
 * the CLI's own convenience — it is how the file the agent's records live in
 * is named, which is what makes the two halves tellable apart by eye. */
export function dumpArgs(
  subject: string,
  named: ReadonlyMap<string, string> = new Map(),
): SessionDumpWriteArgs {
  const at = subject.indexOf(AGENT_MARK);
  const sid = at === -1 ? subject : subject.slice(0, at);
  const agent = at === -1 ? undefined : subject.slice(at + AGENT_MARK.length);
  const types = named.get("types");
  const preset = named.get("preset");
  return {
    sid,
    ...(agent === undefined || agent === "" ? {} : { agent_id: agent }),
    ...(preset === undefined ? {} : { preset }),
    ...(types === undefined
      ? {}
      : {
          types: types
            .split(",")
            .map((one) => one.trim())
            .filter((one) => one !== ""),
        }),
    ...bound("since", named.get("since")),
    ...bound("until", named.get("until")),
  };
}

const AGENT_MARK = "/agent-";

/** One bound, as whichever of the two kinds it was written in.
 *
 * A time and a record id cannot be confused for one another — one parses as a
 * moment and the other does not — so the caller writes what they have rather
 * than saying which it is. */
function bound(kind: "since" | "until", value: string | undefined): Record<string, unknown> {
  if (value === undefined || value === "") return {};
  const at = moment(value);
  return at === undefined ? { [`${kind}_uuid`]: value } : { [`${kind}_at`]: at };
}

function moment(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function chars(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CommandError("invalid_args", "--max-chars は 1 以上の整数です");
  }
  return limit;
}

/** `ccmsg post <sid> <text>`: start a conversation with another session. */
function post(args: readonly string[]): Promise<unknown> {
  const parsed = options(args, ["sid"]);
  const [to, text] = parsed.rest;
  if (to === undefined || text === undefined) {
    throw new CommandError("invalid_args", "使い方: ccmsg post <sid> <text>");
  }
  return send(parsed.named.get("sid"), { to, text });
}

/** `ccmsg reply <mid> <text>`: answer a message, which is the line the contract
 * writes into every message delivered over the harness's socket.
 *
 * `--to` is the recipient, and there is no second source for it: a `mid` names
 * the instance that issued it and its number, so nothing in it says which
 * session sent the message, and no op resolves one. The value is in the
 * delivered envelope as `ccmsg-from`.
 *
 * Without `--to` the answer is for a person, because that is the one message
 * whose reply line carries no addressee: `user` is not a sid and `message.send`
 * addresses a sid, so there is nothing to send to. The contract leaves how such
 * an answer arrives to the instance and names the route — it reaches them as a
 * notification, which is `notify.send`. The caller runs the line either way and
 * does not have to know which of the two it became. */
function reply(args: readonly string[]): Promise<unknown> {
  const parsed = options(args, ["sid", "to"]);
  const [mid, text] = parsed.rest;
  if (mid === undefined || text === undefined) {
    throw new CommandError("invalid_args", "使い方: ccmsg reply <mid> <text> [--to <相手の sid>]");
  }
  const named = parsed.named.get("sid");
  const to = parsed.named.get("to");
  if (to === undefined) return announce(named, { text });
  return send(named, { to, text, reply_to: mid });
}

/** `ccmsg notify <text>`: a line for whoever is watching. Nothing is held and
 * nothing is acknowledged, so there is no outcome to report beyond the op
 * having been accepted. */
function notify(args: readonly string[]): Promise<unknown> {
  const parsed = options(args, ["sid", "about"]);
  const [text] = parsed.rest;
  if (text === undefined) {
    throw new CommandError("invalid_args", "使い方: ccmsg notify <text> [--about <sid>]");
  }
  const about = parsed.named.get("about");
  return announce(parsed.named.get("sid"), {
    text,
    ...(about === undefined ? {} : { sid: about }),
  });
}

/** `ccmsg stopping`: this session is about to go.
 *
 * What it buys is the difference between Paused and Disappeared (§5.2): the
 * instance holds the declaration until the connection closes, and the entry it
 * then writes carries the instant it was told. The connection closing is the
 * second half of that, so the command says its piece and leaves — which is
 * what a session-end hook does anyway.
 *
 * A session that says this and then carries on is not held to it: it stays
 * connected and stays live, and the declaration is spent whenever it does go. */
export async function stopping(args: readonly string[], read?: Read): Promise<unknown> {
  const parsed = options(args, ["sid", "reason"], ["hook"]);
  const event = parsed.flags.has("hook") ? await hookEvent(read) : {};
  const reason = parsed.named.get("reason") ?? event.reason;
  // A hook is told things this process cannot work out for itself — where the
  // transcript is, above all — so the departure says them rather than only
  // what the working directory reveals.
  return await call(
    parsed.named.get("sid") ?? event.sid,
    { op: "session.stopping", ...(reason === undefined ? {} : { reason }) },
    stated(parsed.named, event),
  );
}

/** `ccmsg hello`: say where this session is working.
 *
 * A greeting is how a session states its repository, workspace and branch, and
 * those are what the instance shows it by — a session that has never said them
 * is shown by its sid, which tells nobody which of a person's sessions it is.
 * The connection is not held afterwards: the session's own client processes
 * make their own, and this one exists to have said the words.
 *
 * Best effort throughout, like the record a `say` leaves. It is run from a
 * session-start hook, where there is nothing a person asked for to fail: no
 * instance running, no session id and a greeting that is turned away all leave
 * the session working exactly as it was, so none of them is worth a line in
 * front of somebody's first prompt. */
export async function hello(args: readonly string[], read?: Read): Promise<unknown> {
  const parsed = options(
    args,
    ["sid", "cwd", "repo", "ws", "repo-root", "branch", "transcript-path", "title"],
    ["hook"],
  );
  const event = parsed.flags.has("hook") ? await hookEvent(read) : {};
  const sid = parsed.named.get("sid") ?? event.sid ?? ownSid();
  if (sid === undefined || sid === "") return { greeted: false, reason: "no_session_id" };
  const meta = stated(parsed.named, event);
  const paths = resolvePaths();
  const conn = await connect(paths.socket);
  if (conn === undefined) return { greeted: false, reason: "no_instance" };
  try {
    await conn.ask({
      op: "hello.session",
      sid,
      protocol_version: PROTOCOL_VERSION,
      ...meta,
    });
    return { greeted: true, sid };
  } catch {
    // The instance went away mid-greeting. Nothing was asked of it beyond
    // being told, so there is nothing to retry and nothing to report.
    return { greeted: false, reason: "no_instance" };
  } finally {
    conn.close();
  }
}

/** What this process says about itself, as options over what it can work out.
 *
 * The derivation is the floor: whoever runs the command may know better —
 * a hook is told the working directory and the transcript by the harness, and
 * a caller may state any field outright — and what is stated wins over what is
 * derived, field by field. */
function stated(
  named: ReadonlyMap<string, string>,
  event: { cwd?: string; transcript_path?: string },
): StatedMeta {
  const cwd = named.get("cwd") ?? event.cwd;
  const transcript = named.get("transcript-path") ?? event.transcript_path;
  const derived = statedMeta(cwd ?? process.cwd());
  return {
    ...derived,
    ...only("repo", named.get("repo")),
    ...only("ws", named.get("ws")),
    ...only("repo_root", named.get("repo-root")),
    ...only("branch", named.get("branch")),
    ...only("title", named.get("title")),
    ...only("transcript_path", transcript),
  };
}

function only(field: keyof StatedMeta, value: string | undefined): StatedMeta {
  return value === undefined || value === "" ? {} : { [field]: value };
}

/** The config home of one agent, as that agent's own variable names it.
 *
 * Its own and no other's: the point of naming the agent is to install into the
 * home that agent reads, and a fallback to somebody else's variable would put
 * the files where the agent will never look. Unset means the agent's own
 * default home, which is where that agent looks when nobody says otherwise. */
function homeOf(agent: Agent): string {
  const named = process.env[HARNESS[agent].homeEnv];
  if (named !== undefined && named !== "" && isAbsolute(named)) return named;
  return join(homedir(), agent === "codex" ? ".codex" : ".claude");
}

/** `ccmsg plugin <what> <agent>`: what ccmsg installs into an agent, and what
 * it takes back out.
 *
 * The agent is named rather than assumed: there will be more than one, and a
 * command that guessed which one a person meant would be the command that
 * writes into the wrong config home. */
async function plugin(
  what: "install" | "status" | "uninstall",
  agent: string | undefined,
): Promise<unknown> {
  if (agent !== undefined && !isHarness(agent)) {
    throw new CommandError(
      "invalid_args",
      `${agent} 用のプラグインはありません (今あるのは ${AGENTS.join(", ")})`,
    );
  }
  if (what !== "status" && agent === undefined) {
    throw new CommandError(
      "invalid_args",
      `使い方: ccmsg plugin ${what} <agent> (今あるのは ${AGENTS.join(", ")})`,
    );
  }
  // `status` with no agent named answers for the config home this process
  // belongs to, which is what the instance there runs.
  const which = agent ?? harnessFor(process.env, resolvePaths().configHome);
  // The config home is that agent's own, and not whichever variable happens to
  // be set: a Codex session started from a Claude Code session carries both,
  // and an install that read the wrong one would write Codex's hooks into
  // Claude Code's config home (§3.8). The marker check is what says the
  // directory really is that agent's.
  const home = configHome(homeOf(which), which);
  const paths = resolvePathsFor(home);
  const outcome: Outcome =
    what === "install"
      ? await install(paths, which, VERSION)
      : what === "status"
        ? await pluginStatus(paths, which)
        : await uninstall(paths, which);
  // A refused step is an error rather than an answer, so the command's exit
  // code says what happened without the report having to be read. The report
  // itself travels with it: what was done before the refusal is what the next
  // attempt starts from.
  if (!outcome.ok) {
    const refused = outcome.refused;
    throw new CommandError(
      "internal_error",
      refused === undefined
        ? `plugin ${what} が完了しませんでした`
        : `${refused.command.join(" ")}: ${refused.said === "" ? `終了コード ${refused.code}` : refused.said}`,
      outcome,
    );
  }
  return outcome;
}

/** One `message.send`. */
function send(named: string | undefined, args: MessageSendArgs): Promise<unknown> {
  return call(named, { op: "message.send", ...args });
}

/** One `notify.send`. */
function announce(named: string | undefined, args: NotifySendArgs): Promise<unknown> {
  return call(named, { op: "notify.send", ...args });
}

/** One op, spoken as the session this process runs inside.
 *
 * The greeting is `hello.session` because that is what the caller is: the
 * instance takes the sender and the subject from the connection rather than
 * from the arguments, so a connection that greeted as anything else has nobody
 * to answer and nothing to be about.
 *
 * It also says where the session is working, because that is what a message's
 * recipient is shown as its sender: the label is built from the repository and
 * workspace the sending connection greeted from, and a greeting that named
 * neither leaves the recipient a sid to read. The words cost one `git` call and
 * they are the difference between "ccmsg/main said this" and a line of hex. */
async function call(
  named: string | undefined,
  request: Record<string, unknown>,
  meta: StatedMeta = statedMeta(),
): Promise<unknown> {
  const sid = named ?? ownSid();
  if (sid === undefined || sid === "") {
    throw new CommandError(
      "invalid_args",
      `自分のセッション ID が分かりません (--sid か ${SESSION_ENV.join(" / ")})`,
    );
  }
  return await exchange(
    { op: "hello.session", sid, protocol_version: PROTOCOL_VERSION, ...meta },
    request,
  );
}

/** One op, spoken as the person at the keyboard.
 *
 * Which is who is asking: reading a transcript is not something a session is a
 * party to, and the ops that do it are open to a person and to nobody else. */
function instanceAsk(request: Record<string, unknown>): Promise<unknown> {
  return exchange({ op: "hello.user", protocol_version: PROTOCOL_VERSION }, request);
}

/** Greet this config home's instance, ask it one thing, and answer with what
 * it said. */
async function exchange(
  greeting: Record<string, unknown>,
  request: Record<string, unknown>,
): Promise<unknown> {
  const paths = resolvePaths();
  const conn = await connect(paths.socket);
  if (conn === undefined) {
    throw new CommandError(
      "instance_unreachable",
      `${paths.socket} に繋がりません (instance は動いていません)`,
    );
  }
  try {
    const greeted = await conn.ask(greeting);
    if (greeted["ok"] !== true) {
      throw new CommandError("forbidden", `hello が拒否されました: ${JSON.stringify(greeted)}`);
    }
    const answer = await conn.ask(request);
    if (answer["ok"] !== true) {
      const error = answer["error"] as { code?: string; msg?: string } | undefined;
      throw new CommandError(
        (error?.code as CommandError["code"] | undefined) ?? "internal_error",
        error?.msg ?? JSON.stringify(answer),
      );
    }
    // A reply carries its result beside the envelope's own fields rather than
    // nested under one, so what the op answered is the frame itself.
    const { ok: _ok, request_id: _id, op: _op, ...result } = answer;
    return result;
  } finally {
    conn.close();
  }
}

/** What one attempt to record a `say` may cost before the speech goes ahead
 * without it. The record is a nicety — which session spoke — and the speech is
 * what the caller asked for, so an instance that has wedged costs latency once
 * rather than silence. */
const SAY_POST_MS = 1_500;

/** How a speech process is started. Named so a test can watch the arguments
 * without the machine making a sound. */
export type Spawn = (command: string[]) => { exited: Promise<number> };

const spawnSpeech: Spawn = (command) =>
  Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });

/** `ccmsg say [say-options] [text...]`: speak, and say who spoke.
 *
 * Every argument goes to the speech binary untouched, so its own flags work and
 * a PATH shim delegating here changes nothing about what the caller gets. The
 * one exception is a lone `--help`, which the binary does not define.
 *
 * No arguments is not an error: `echo hi | say` reads its text from stdin, and
 * that is the form a shim exists to preserve. */
export async function say(args: readonly string[], spawn: Spawn = spawnSpeech): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(help([ROOT, ROOT.children?.find((one) => one.name === "say") as Command]));
    return 0;
  }
  await posted(args.join(" "));
  const binary = process.env["CCMSG_SAY_BIN"] ?? SYSTEM_SAY;
  return await spawn([binary, ...args]).exited;
}

/** Tell the instance this session spoke, and say nothing if it cannot be told.
 *
 * Best effort on purpose: no instance, a refused greeting or a socket that goes
 * away under us all leave the speech itself untouched, and a message about the
 * record would be noise in front of the thing the caller wanted. Text the
 * contract will not take — a bare `say` reading its text from stdin has none —
 * is nothing to record either. */
async function posted(text: string): Promise<void> {
  const sid = ownSid();
  if (text === "" || sid === undefined || sid === "") return;
  const conn = await connect(resolvePaths().socket);
  if (conn === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const record = async (): Promise<void> => {
    const greeting = await conn.ask({
      op: "hello.session",
      sid,
      protocol_version: PROTOCOL_VERSION,
      ...statedMeta(),
    });
    if (greeting["ok"] === true) await conn.ask({ op: "say.post", text });
  };
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SAY_POST_MS);
  });
  try {
    // Raced rather than cancelled: an exchange that never answers is one this
    // waits out, and closing under it would leave a reply nobody resolves.
    await Promise.race([record(), budget]);
  } catch {
    // The instance went away mid-exchange. The speech is what was asked for
    // and it happens regardless.
  } finally {
    clearTimeout(timer);
    conn.close();
  }
}

/** Long options and what is left over.
 *
 * Only the names the command declares are accepted, and `--` ends the options
 * so a text beginning with a dash is still a text. */
function options(
  args: readonly string[],
  named: readonly string[],
  flags: readonly string[] = [],
): { named: Map<string, string>; flags: Set<string>; rest: string[] } {
  const values = new Map<string, string>();
  const raised = new Set<string>();
  const rest: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") {
      rest.push(...args.slice(at + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (flags.includes(name)) {
      raised.add(name);
      continue;
    }
    if (!named.includes(name)) {
      throw new CommandError("invalid_args", `知らないオプションです: ${arg}`);
    }
    const value = args[at + 1];
    if (value === undefined) throw new CommandError("invalid_args", `${arg} には値が要ります`);
    values.set(name, value);
    at += 1;
  }
  return { named: values, flags: raised, rest };
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
