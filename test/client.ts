/** Line clients for the two transports, so one test body can be run against
 * both and see the same connection (daemon-v2 §3.1). */
export interface LineClient {
  send(frame: object): void;
  /** Send a line as text, for the shapes a frame cannot express (a line that is
   * not JSON, a line past the limit). */
  sendRaw(text: string): void;
  /** The next line the instance writes, parsed. */
  next(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

class Lines {
  #buffer = "";
  readonly #ready: Record<string, unknown>[] = [];
  #waiting: ((line: Record<string, unknown>) => void) | undefined;

  push(text: string): void {
    this.#buffer += text;
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
    const ready = this.#ready.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }
}

export async function connectUds(path: string): Promise<LineClient> {
  const lines = new Lines();
  /** A unix socket takes what fits and reports a short count, so what it did
   * not take waits for the next `drain` — the client side of the same
   * backpressure the instance handles with its write queue. */
  let pending: Uint8Array | undefined;
  const flush = (socket: Bun.Socket<undefined>) => {
    while (pending !== undefined) {
      const written = socket.write(pending);
      if (written <= 0) return;
      pending = written === pending.length ? undefined : pending.subarray(written);
    }
  };
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_socket, chunk) {
        lines.push(new TextDecoder().decode(chunk));
      },
      drain(socket) {
        flush(socket);
      },
    },
  });
  const write = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    pending = pending === undefined ? bytes : concat(pending, bytes);
    flush(socket);
  };
  return {
    send: (frame) => {
      write(`${JSON.stringify(frame)}\n`);
    },
    sendRaw: write,
    next: () => lines.next(),
    close: async () => {
      socket.end();
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  return both;
}

/** A WebSocket client, presenting the access token a person authenticated for.
 *
 * The token rides in a subprotocol because that is the only field a browser
 * lets a handshake carry (DR-0001 §2.4), so a test mints one from the instance
 * it is connecting to and offers it the same way. A listener with no entry
 * policy asks for none, and such a test passes none. */
export async function connectWs(address: string, token?: string): Promise<LineClient> {
  const lines = new Lines();
  const ws = new WebSocket(
    `ws://${address}/ws`,
    token === undefined ? [] : [`ccmsg.token.${token}`],
  );
  ws.addEventListener("message", (event: MessageEvent) => {
    lines.push(String(event.data));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve();
    });
    ws.addEventListener("error", () => {
      reject(new Error("the websocket did not open"));
    });
  });
  return {
    send: (frame) => {
      ws.send(`${JSON.stringify(frame)}\n`);
    },
    sendRaw: (text) => {
      ws.send(text);
    },
    next: () => lines.next(),
    close: () =>
      new Promise<void>((resolve) => {
        ws.addEventListener("close", () => {
          resolve();
        });
        ws.close();
      }),
  };
}
