import { PROTOCOL_VERSION } from "@ccmsg/protocol";

/** One short exchange over an instance's unix socket.
 *
 * The CLI asks one thing at a time, so a `request_id` is a counter and the
 * answer is the next frame: nothing here needs correlation, and the connection
 * lives no longer than the command that opened it. */
export interface Conn {
  ask(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The next frame the instance sends without having been asked for one: a
   * topic frame, or an event about the connection itself. Every frame arrives
   * on the one stream `ask` reads its reply from, so a caller that subscribes
   * reads on with this instead of asking again. */
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

/** The instance behind a socket path, or nothing when there is none. */
export async function connect(path: string): Promise<Conn | undefined> {
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
    next() {
      return replies.next();
    },
    close() {
      socket.end();
    },
  };
}

/** Greet as the person running the command.
 *
 * `role: "user"` because that is what the caller is: the lifecycle ops belong
 * to whoever operates the host, not to a session speaking from inside a turn. */
export function greetAsUser(conn: Conn): Promise<Record<string, unknown>> {
  return conn.ask({ op: "hello", role: "user", protocol_version: PROTOCOL_VERSION });
}

/** Reassemble the replies of one exchange, by arrival order. */
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
