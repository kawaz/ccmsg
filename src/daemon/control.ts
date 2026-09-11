import { PROTOCOL_VERSION } from "@ccmsg/protocol";

/** One short exchange over an instance's unix socket.
 *
 * The CLI asks one thing at a time, so a `request_id` is a counter — and the
 * answer is the frame carrying it, not the next one to arrive: an instance
 * pushes topic frames of its own accord, and one landing mid-exchange would
 * otherwise be read as the reply. */
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
      const id = `${counter}`;
      // Registered before the write, so a reply that arrives in the same turn
      // is the one this call settles on.
      const answer = replies.answer(id);
      socket.write(`${JSON.stringify({ request_id: id, ...request })}\n`);
      return answer;
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
 * `hello.user` because that is what the caller is: the lifecycle ops belong
 * to whoever operates the host, not to a session speaking from inside a turn. */
export function greetAsUser(conn: Conn): Promise<Record<string, unknown>> {
  return conn.ask({ op: "hello.user", protocol_version: PROTOCOL_VERSION });
}

/** Sort what arrives on one connection into the answer somebody is waiting for
 * and everything else.
 *
 * By `request_id` rather than by arrival order, because the two are not the
 * same stream: an instance pushes topic frames of its own accord (§6), and one
 * of those landing between a request and its reply would otherwise be read as
 * the reply. It is not a rare window — greeting an instance that has mesh peers
 * is enough, since a peer connecting moves a row on `instances`. */
class Replies {
  readonly #unasked: Record<string, unknown>[] = [];
  readonly #answers = new Map<string, (frame: Record<string, unknown>) => void>();
  readonly #ready = new Map<string, Record<string, unknown>>();
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
      const id = frame["request_id"];
      if (typeof id === "string") {
        const asked = this.#answers.get(id);
        if (asked !== undefined) {
          this.#answers.delete(id);
          asked(frame);
          continue;
        }
        if (this.#answers.size > 0) {
          // A reply to something still being waited for by somebody who has not
          // got here yet: held by its id rather than queued as unasked-for.
          this.#ready.set(id, frame);
          continue;
        }
      } else if (frame["ev"] === undefined && this.#answers.size === 1) {
        // An answer that named nothing, while exactly one thing is waiting for
        // one: it is that one. Matching only by id would leave a caller waiting
        // for ever on a refusal raised before the request could be read, which
        // is the moment an answer is most needed.
        for (const [pending, settle] of this.#answers) {
          this.#answers.delete(pending);
          settle(frame);
        }
        continue;
      }
      const waiting = this.#waiting;
      if (waiting === undefined) this.#unasked.push(frame);
      else {
        this.#waiting = undefined;
        waiting(frame);
      }
    }
  }

  /** The reply to one request, whenever it lands. */
  answer(id: string): Promise<Record<string, unknown>> {
    const already = this.#ready.get(id);
    if (already !== undefined) {
      this.#ready.delete(id);
      return Promise.resolve(already);
    }
    return new Promise((resolve) => {
      this.#answers.set(id, resolve);
    });
  }

  /** The next frame nobody asked for. */
  next(): Promise<Record<string, unknown>> {
    const first = this.#unasked.shift();
    if (first !== undefined) return Promise.resolve(first);
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }
}
