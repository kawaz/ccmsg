import { BaseConn, type Conn, type ConnRegistry } from "./conn.ts";
import { createDriver, type FrameHandler } from "./driver.ts";
import { LineReader, MAX_LINE_BYTES, WriteQueue } from "./framing.ts";
import { type EntryPolicy, OPEN } from "./entry.ts";
import type { Listener } from "./listener.ts";

interface WsState {
  conn: BaseConn;
  reader: LineReader;
  queue: WriteQueue<string>;
}

export interface WsOptions {
  readonly hostname?: string;
  /** 0 asks the kernel for a free port; the bound one is on `address`. */
  readonly port: number;
  readonly path?: string;
  readonly conns: ConnRegistry;
  readonly handle: FrameHandler;
  readonly entry?: EntryPolicy;
  readonly onConn?: (conn: Conn) => void;
}

/** Accept the webui, and later mesh peers, over WebSocket.
 *
 * A WS message is a message, not a stream, but it carries the same
 * newline-delimited framing as the unix socket: one line is one frame, whether
 * a message holds one line or several. Backpressure differs from UDS — a send
 * is either buffered whole by Bun or dropped whole — and the queue absorbs
 * that difference here (§3.1). */
export function serveWs(options: WsOptions): Listener {
  const path = options.path ?? "/ws";
  const entry = options.entry ?? OPEN;
  // The per-connection state is made in `open`, where the socket to write to
  // exists, so the upgrade carries nothing and the socket keeps no data of its
  // own.
  const states = new WeakMap<object, WsState>();
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    fetch(request, srv) {
      if (entry.allowRequest?.(request) === false)
        return new Response("Forbidden", { status: 403 });
      if (new URL(request.url).pathname !== path) return new Response("Not Found", { status: 404 });
      if (srv.upgrade(request)) return undefined;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      // The line limit is enforced by the framing both transports share, which
      // answers `bad_request` and keeps the connection. This cap only bounds
      // one message's memory, so it sits above the line limit — a message at
      // or under it always reaches the framing and gets that answer.
      maxPayloadLength: MAX_LINE_BYTES + 64 * 1024,
      open(ws) {
        const queue = new WriteQueue<string>({
          encode: (line) => line,
          // 0 means the message was dropped; anything else means it was sent
          // or is buffered by Bun and will be, so re-queuing it would send it
          // twice.
          write: (chunk) => (ws.send(chunk) === 0 ? chunk : undefined),
        });
        const conn = new BaseConn(options.conns.nextId(), {
          send: (line) => {
            queue.push(line);
          },
          close: () => {
            ws.close();
          },
        });
        const driver = createDriver(conn, options.handle);
        states.set(ws, { conn, queue, reader: new LineReader(driver) });
        options.conns.add(conn);
        options.onConn?.(conn);
      },
      message(ws, message) {
        const state = states.get(ws);
        if (state === undefined) return;
        const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
        state.reader.push(bytes);
        // A message need not end in a newline, and one message is one frame on
        // this transport, so the last line is complete even without it.
        state.reader.push(NEWLINE);
      },
      drain(ws) {
        states.get(ws)?.queue.drain();
      },
      close(ws) {
        const state = states.get(ws);
        if (state === undefined) return;
        options.conns.remove(state.conn);
        state.conn.closed();
      },
    },
  });

  return {
    kind: "ws",
    address: `${server.hostname}:${server.port}`,
    async close() {
      await server.stop(true);
    },
  };
}

const NEWLINE = new Uint8Array([0x0a]);
