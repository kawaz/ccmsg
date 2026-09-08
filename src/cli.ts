#!/usr/bin/env bun
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { isRunning, resolvePaths, start } from "./instance/index.ts";

const USAGE = `ccmsg — one instance per config home

サブコマンド:
  daemon run     この config home の instance を foreground で起動する
  daemon stop    起動中の instance に停止を要求する (unix socket 経由)

グローバルオプション:
  -h, --help     このヘルプを表示する

環境変数:
  CLAUDE_CONFIG_DIR   この instance が答える唯一の config home
  CCMSG_CONFIG_DIR    config の置き場を直接指定する (既定は XDG_CONFIG_HOME 由来)
  CCMSG_STATE_DIR     state・socket・pid・ログの置き場を直接指定する
`;

/** The whole CLI: the two commands the instance's own lifecycle needs.
 *
 * The rest of the vocabulary is the contract's ops, which no command speaks
 * yet — the surface stays at what `daemon run` and `daemon stop` require so it
 * does not have to be unpicked when the ops arrive. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, sub] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command !== "daemon") {
    process.stderr.write(`ccmsg: 知らないサブコマンドです: ${command}\n\n${USAGE}`);
    return 2;
  }
  switch (sub) {
    case "run":
      return run();
    case "stop":
      return stop();
    default:
      process.stdout.write(USAGE);
      return sub === undefined ? 0 : 2;
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

/** Ask the running instance to stop, over its own socket.
 *
 * It is the contract's op rather than a signal, so the request goes through
 * the same authorization every other op does and the caller is told it was
 * accepted before the process goes down. */
async function stop(): Promise<number> {
  const paths = resolvePaths();
  const replies = new Replies();
  let socket: Bun.Socket<undefined>;
  try {
    socket = await Bun.connect({
      unix: paths.socket,
      socket: {
        data(_socket, chunk) {
          replies.push(chunk);
        },
      },
    });
  } catch {
    process.stderr.write(`ccmsg: ${paths.socket} に繋がりません (instance は動いていません)\n`);
    return 1;
  }
  socket.write(
    `${JSON.stringify({ op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION })}\n`,
  );
  const greeting = await replies.next();
  if (greeting["ok"] !== true) {
    process.stderr.write(`ccmsg: hello が拒否されました: ${JSON.stringify(greeting)}\n`);
    socket.end();
    return 1;
  }
  socket.write(`${JSON.stringify({ op: "instance_shutdown", request_id: "2" })}\n`);
  const answer = await replies.next();
  socket.end();
  if (answer["ok"] !== true) {
    process.stderr.write(`ccmsg: 停止を拒否されました: ${JSON.stringify(answer)}\n`);
    return 1;
  }
  process.stdout.write("ccmsg: 停止を要求しました\n");
  return 0;
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
