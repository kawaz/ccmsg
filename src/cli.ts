#!/usr/bin/env bun
import {
  type MessageSendArgs,
  type MessageSendResult,
  type NotifySendArgs,
  PROTOCOL_VERSION,
} from "@ccmsg/protocol";
import { isRunning, resolvePaths, start } from "./instance/index.ts";

/** The system speech binary. Absolute on purpose: a `say` shim earlier on PATH
 * is what delegates here, so resolving through PATH again would re-enter the
 * shim. */
const SYSTEM_SAY = "/usr/bin/say";

const USAGE = `ccmsg — one instance per config home

サブコマンド:
  post <sid> <text>    別のセッションへメッセージを送る
  reply <mid> <text>   受け取ったメッセージに返信する (--to で宛先セッション)
  notify <text>        見ている人へ一行知らせる (保持されない、返事も来ない)
  say [say-options] [text...]
                       ${SYSTEM_SAY} で発声し、どのセッションが喋ったかを知らせる
  daemon run           この config home の instance を foreground で起動する
  daemon stop          起動中の instance に停止を要求する (unix socket 経由)

post / reply / notify のオプション:
  --sid <sid>    自分のセッション ID (既定は CLAUDE_CODE_SESSION_ID)
  --to <sid>     reply の宛先セッション (受け取った封筒の ccmsg-from の値)
                 省略すると人 (user) への返信として通知で届く
  --about <sid>  notify が知らせるセッション (既定は自分)

say の引数は ${SYSTEM_SAY} へそのまま渡す (ccmsg 独自のオプションは無い)。
唯一の例外は単独の --help / -h で、この ccmsg のヘルプを表示する。

グローバルオプション:
  -h, --help     このヘルプを表示する

環境変数:
  CLAUDE_CONFIG_DIR       この instance が答える唯一の config home
  CLAUDE_CODE_SESSION_ID  自分のセッション ID (post / reply / notify / say の名乗り)
  CCMSG_CONFIG_DIR        config の置き場を直接指定する (既定は XDG_CONFIG_HOME 由来)
  CCMSG_STATE_DIR         state・socket・pid・ログの置き場を直接指定する
  CCMSG_SAY_BIN           発声に使うバイナリ (既定は ${SYSTEM_SAY})
`;

/** The CLI: the instance's own lifecycle, and what a session speaks from
 * inside its turn.
 *
 * `post` and `reply` are the same op — a message goes to a session either way,
 * and what `reply` adds is the frame it answers (`reply_to`). They are two
 * commands rather than one with a flag because that is how they are reached:
 * one is how a session starts a conversation, the other is the line the
 * contract writes into a delivered message.
 *
 * `notify` and `say` are the other direction, towards a person watching rather
 * than towards a session. They are two commands for the same reason: one is a
 * line to read, the other is a line to hear, and only the second has a speech
 * binary to hand its arguments to. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (command) {
    case "daemon":
      return daemon(argv[1]);
    case "post":
      return post(argv.slice(1));
    case "reply":
      return reply(argv.slice(1));
    case "notify":
      return notify(argv.slice(1));
    // `say` takes over its arguments before any parsing of ours: they belong to
    // the speech binary, and an option of ours in the middle of them would
    // change what a shim's users get.
    case "say":
      return say(argv.slice(1));
    default:
      process.stderr.write(`ccmsg: 知らないサブコマンドです: ${command}\n\n${USAGE}`);
      return 2;
  }
}

function daemon(sub: string | undefined): Promise<number> {
  switch (sub) {
    case "run":
      return run();
    case "stop":
      return stop();
    default:
      process.stdout.write(USAGE);
      return Promise.resolve(sub === undefined ? 0 : 2);
  }
}

/** Run the instance in the foreground, until it is asked to stop or the
 * terminal takes it away. */
async function run(): Promise<number> {
  const outcome = await start();
  if (!isRunning(outcome)) {
    process.stderr.write(
      `ccmsg: この config home の instance は既に動いています (pid ${outcome.pid})\n`,
    );
    return 1;
  }
  const instance = outcome;
  // A signal is a request to leave, and leaving is the ordered shutdown of
  // §8.5 — the same one `instance_shutdown` runs, so a client sees the same
  // departure either way. The listeners are removed once it has run, because a
  // signal listener keeps the event loop alive and the process would sit at an
  // empty loop instead of exiting.
  const signals = ["SIGINT", "SIGTERM"] as const;
  const asked = () => {
    void instance.stop();
  };
  for (const signal of signals) process.on(signal, asked);
  await instance.whenStopped();
  for (const signal of signals) process.off(signal, asked);
  return 0;
}

/** `ccmsg post <sid> <text>`: start a conversation with another session. */
function post(args: readonly string[]): Promise<number> {
  const parsed = options(args, ["sid"]);
  if (typeof parsed === "string") return fail(parsed);
  const [to, text] = parsed.rest;
  if (to === undefined || text === undefined) {
    return fail("使い方: ccmsg post <sid> <text> [--sid <自分の sid>]");
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
 * whose reply line carries no addressee: `user` is not a sid and `message_send`
 * addresses a sid, so there is nothing to send to. The contract leaves how such
 * an answer arrives to the instance and names the route — it reaches them as a
 * notification, which is `notify_send`. The caller runs the line either way and
 * does not have to know which of the two it became. */
function reply(args: readonly string[]): Promise<number> {
  const parsed = options(args, ["sid", "to"]);
  if (typeof parsed === "string") return fail(parsed);
  const [mid, text] = parsed.rest;
  if (mid === undefined || text === undefined) {
    return fail("使い方: ccmsg reply <mid> <text> [--to <相手の sid>]");
  }
  const named = parsed.named.get("sid");
  const to = parsed.named.get("to");
  if (to === undefined) return announce(named, { text });
  return send(named, { to, text, reply_to: mid });
}

/** `ccmsg notify <text>`: a line for whoever is watching. Nothing is held and
 * nothing is acknowledged, so there is no outcome to report beyond the op
 * having been accepted. */
function notify(args: readonly string[]): Promise<number> {
  const parsed = options(args, ["sid", "about"]);
  if (typeof parsed === "string") return fail(parsed);
  const [text] = parsed.rest;
  if (text === undefined) return fail("使い方: ccmsg notify <text> [--about <sid>]");
  const about = parsed.named.get("about");
  return announce(parsed.named.get("sid"), {
    text,
    ...(about === undefined ? {} : { sid: about }),
  });
}

/** One `message_send`. */
function send(named: string | undefined, args: MessageSendArgs): Promise<number> {
  return call(named, { op: "message_send", ...args }, (answer) =>
    describe(answer as unknown as MessageSendResult),
  );
}

/** One `notify_send`. */
function announce(named: string | undefined, args: NotifySendArgs): Promise<number> {
  return call(named, { op: "notify_send", ...args }, () => "ccmsg: 知らせました");
}

/** One op, spoken as the session this process runs inside.
 *
 * The greeting is `role: "session"` because that is what the caller is: the
 * instance takes the sender and the subject from the connection rather than
 * from the arguments, so a connection that greeted as anything else has nobody
 * to answer and nothing to be about. */
async function call(
  named: string | undefined,
  request: Record<string, unknown>,
  report: (answer: Record<string, unknown>) => string,
): Promise<number> {
  const sid = named ?? process.env["CLAUDE_CODE_SESSION_ID"];
  if (sid === undefined || sid === "") {
    return fail("ccmsg: 自分のセッション ID が分かりません (--sid か CLAUDE_CODE_SESSION_ID)");
  }
  const paths = resolvePaths();
  const conn = await connect(paths.socket);
  if (conn === undefined) {
    return fail(`ccmsg: ${paths.socket} に繋がりません (instance は動いていません)`);
  }
  try {
    const greeting = await conn.ask({
      op: "hello",
      role: "session",
      sid,
      protocol_version: PROTOCOL_VERSION,
    });
    if (greeting["ok"] !== true) {
      return fail(`ccmsg: hello が拒否されました: ${JSON.stringify(greeting)}`);
    }
    const answer = await conn.ask(request);
    if (answer["ok"] !== true) {
      return fail(`ccmsg: 送れませんでした: ${JSON.stringify(answer)}`);
    }
    // A reply carries its result beside the envelope's own fields rather than
    // nested under one, so what the op answered is the frame itself.
    process.stdout.write(`${report(answer)}\n`);
    return 0;
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
    process.stdout.write(USAGE);
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
  const sid = process.env["CLAUDE_CODE_SESSION_ID"];
  if (text === "" || sid === undefined || sid === "") return;
  const conn = await connect(resolvePaths().socket);
  if (conn === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const record = async (): Promise<void> => {
    const greeting = await conn.ask({
      op: "hello",
      role: "session",
      sid,
      protocol_version: PROTOCOL_VERSION,
    });
    if (greeting["ok"] === true) await conn.ask({ op: "say_post", text });
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

/** What became of the message, in the words of §4.2: delivered, or waiting for
 * a recipient that is named along with why it is waiting. */
function describe(result: MessageSendResult): string {
  if (result.delivered) return "ccmsg: 届きました";
  const candidates = result.candidates?.map((session) => session.sid) ?? [];
  const instead = candidates.length === 0 ? "" : `。代わりに送れる相手: ${candidates.join(", ")}`;
  return `ccmsg: inbox に積みました (${result.reason ?? "理由なし"})${instead}`;
}

/** Long options and what is left over.
 *
 * Only the names the command declares are accepted, and `--` ends the options
 * so a text beginning with a dash is still a text. */
function options(
  args: readonly string[],
  named: readonly string[],
): { named: Map<string, string>; rest: string[] } | string {
  const values = new Map<string, string>();
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
    if (!named.includes(name)) return `ccmsg: 知らないオプションです: ${arg}`;
    const value = args[at + 1];
    if (value === undefined) return `ccmsg: ${arg} には値が要ります`;
    values.set(name, value);
    at += 1;
  }
  return { named: values, rest };
}

function fail(message: string): Promise<number> {
  process.stderr.write(`${message}\n`);
  return Promise.resolve(1);
}

/** Ask the running instance to stop, over its own socket.
 *
 * It is the contract's op rather than a signal, so the request goes through
 * the same authorization every other op does and the caller is told it was
 * accepted before the process goes down. */
async function stop(): Promise<number> {
  const paths = resolvePaths();
  const conn = await connect(paths.socket);
  if (conn === undefined) {
    return fail(`ccmsg: ${paths.socket} に繋がりません (instance は動いていません)`);
  }
  try {
    const greeting = await conn.ask({
      op: "hello",
      role: "user",
      protocol_version: PROTOCOL_VERSION,
    });
    if (greeting["ok"] !== true) {
      return fail(`ccmsg: hello が拒否されました: ${JSON.stringify(greeting)}`);
    }
    const answer = await conn.ask({ op: "instance_shutdown" });
    if (answer["ok"] !== true) {
      return fail(`ccmsg: 停止を拒否されました: ${JSON.stringify(answer)}`);
    }
    process.stdout.write("ccmsg: 停止を要求しました\n");
    return 0;
  } finally {
    conn.close();
  }
}

interface Conn {
  /** One request, and the reply to it. The CLI asks one thing at a time, so
   * the `request_id` is a counter and the answer is simply the next frame. */
  ask(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/** The instance's own socket, or nothing when there is no instance behind it. */
async function connect(path: string): Promise<Conn | undefined> {
  const replies = new Replies();
  let socket: Bun.Socket<undefined>;
  try {
    socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, chunk) {
          replies.push(chunk);
        },
      },
    });
  } catch {
    return undefined;
  }
  let counter = 0;
  return {
    ask(request) {
      counter += 1;
      socket.write(`${JSON.stringify({ request_id: `${counter}`, ...request })}\n`);
      return replies.next();
    },
    close() {
      socket.end();
    },
  };
}

/** Reassemble the replies of one short exchange. The CLI sends one request at
 * a time, so this needs no correlation beyond arrival order. */
class Replies {
  readonly #ready: Record<string, unknown>[] = [];
  #waiting: ((frame: Record<string, unknown>) => void) | undefined;
  #buffer = "";

  push(chunk: Uint8Array): void {
    this.#buffer += new TextDecoder().decode(chunk);
    let at: number;
    while ((at = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      const waiting = this.#waiting;
      if (waiting === undefined) this.#ready.push(frame);
      else {
        this.#waiting = undefined;
        waiting(frame);
      }
    }
  }

  next(): Promise<Record<string, unknown>> {
    const first = this.#ready.shift();
    if (first !== undefined) return Promise.resolve(first);
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
