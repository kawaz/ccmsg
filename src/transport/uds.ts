import { chmodSync } from "node:fs";
import { BaseConn, type Conn, type ConnRegistry } from "./conn.ts";
import { createDriver, type FrameHandler } from "./driver.ts";
import { LineReader, WriteQueue } from "./framing.ts";
import type { Listener } from "./listener.ts";

interface UdsState {
  conn: BaseConn;
  reader: LineReader;
  queue: WriteQueue<Uint8Array>;
}

export interface UdsOptions {
  /** The socket path.
   *
   * §8.5 asks that closing leave the path alone, because a successor's socket
   * may already stand there. Bun's listener unlinks it in `stop()` regardless
   * (measured against Bun 1.3.13: the path is gone the moment `stop` returns),
   * so this layer cannot honour that on its own — what it can do is not add a
   * second removal of its own. */
  readonly path: string;
  readonly conns: ConnRegistry;
  readonly handle: FrameHandler;
  /** Runs for each accepted connection, before any frame is read. */
  readonly onConn?: (conn: Conn) => void;
}

/** Accept sessions and the CLI on the instance's unix socket.
 *
 * `socket.write` hands the bytes to sendto(2) and returns a short count when
 * the socket buffer is full, so the unsent tail is kept by the queue and
 * written again on `drain` — the difference from WS that §3.1 puts in this
 * layer. */
export function listenUds(options: UdsOptions): Listener {
  const server = Bun.listen<UdsState>({
    unix: options.path,
    socket: {
      open(socket) {
        const queue = new WriteQueue<Uint8Array>({
          encode: (line) => new TextEncoder().encode(line),
          write(chunk) {
            const written = socket.write(chunk);
            if (written < 0) return undefined; // closing: nothing more will go
            return written === chunk.length ? undefined : chunk.subarray(written);
          },
          flush: () => {
            socket.flush();
          },
        });
        const conn = new BaseConn(options.conns.nextId(), {
          send: (line) => {
            queue.push(line);
          },
          close: () => {
            socket.end();
          },
        });
        const driver = createDriver(conn, options.handle);
        socket.data = { conn, queue, reader: new LineReader(driver) };
        options.conns.add(conn);
        options.onConn?.(conn);
      },
      data(socket, chunk) {
        socket.data.reader.push(chunk);
      },
      drain(socket) {
        socket.data.queue.drain();
      },
      close(socket) {
        const state = socket.data as UdsState | undefined;
        if (state === undefined) return;
        options.conns.remove(state.conn);
        state.conn.closed();
      },
    },
  });
  // Only this user's sessions may speak to the instance; the socket's own mode
  // is the whole of the entry check on this transport.
  chmodSync(options.path, 0o600);

  return {
    kind: "uds",
    address: options.path,
    async close() {
      server.stop(true);
    },
  };
}
