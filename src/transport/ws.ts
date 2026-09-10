import { MAX_FRAME_BYTES } from "@ccmsg/protocol";
import { BaseConn, type Conn, type ConnRegistry } from "./conn.ts";
import { createDriver, type FrameHandler } from "./driver.ts";
import { LineReader, WriteQueue } from "./framing.ts";
import { type AuthorizedUpgrade, type EntryPolicy, OPEN } from "./entry.ts";
import type { Listener } from "./listener.ts";

/** What the upgrade hands the socket: whether it was let in as a peer. */
interface UpgradeData {
  readonly mesh: boolean;
  /** Who the handshake's access token admitted, on a person's connection. */
  readonly auth?: AuthorizedUpgrade;
}

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
  /** `mesh` is set when the handshake was let in as a peer rather than on the
   * entry token, so whoever holds the connection can keep it to the one
   * exchange that can prove what it is. */
  readonly onConn?: (
    conn: Conn,
    info: { readonly mesh: boolean; readonly auth?: AuthorizedUpgrade },
  ) => void;
  /** An HTTP request that is not the upgrade, answered by whoever wants it.
   *
   * It shares this listener rather than opening a second one: a producer that
   * posts to this instance reaches it at the address it already has, and the
   * entry check of §3.1 runs before this is asked, so a route cannot be
   * reached by anyone the WebSocket could not be. Answering `undefined` leaves
   * the request to the upgrade, which refuses it.
   *
   * `source` is the peer address the server observed, passed for the reason
   * `allowRequest` is given it: what a route can be told about where a request
   * came from is written by whoever is in front of us, and only the listener
   * knows who that actually was. */
  readonly route?: (request: Request, source: string | undefined) => Promise<Response | undefined>;
}

/** Accept the webui, and later mesh peers, over WebSocket.
 *
 * A WS message is a message, not a stream, but it carries the same
 * newline-delimited framing as the unix socket: one line is one frame, whether
 * a message holds one line or several. Backpressure differs from UDS — a send
 * is either buffered whole by Bun or dropped whole — and the queue absorbs
 * that difference here (§3.1). */
export function serveWs(options: WsOptions): Listener {
  const path = options.path ?? ENTRY_PATH;
  const entry = options.entry ?? OPEN;
  // The per-connection state is made in `open`, where the socket to write to
  // exists, so the upgrade carries nothing and the socket keeps no data of its
  // own.
  const states = new WeakMap<object, WsState>();
  const server = Bun.serve<UpgradeData, never>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    async fetch(request, srv) {
      const source = srv.requestIP(request)?.address;
      if (entry.allowRequest?.(request, source) === false) {
        return new Response("Forbidden", { status: 403 });
      }
      const routed = await options.route?.(request, source);
      if (routed !== undefined) return routed;
      if (!entryPath(new URL(request.url).pathname, path)) {
        return new Response("Not Found", { status: 404 });
      }
      // The handshake's own check, asked after the routes so a route carrying
      // its own secret is not also asked for the entry token.
      const decision = entry.allowUpgrade?.(request) ?? { ok: true as const };
      if (!decision.ok) return new Response(decision.reason, { status: 401 });
      const selected = decision.protocol;
      if (
        srv.upgrade(request, {
          data: {
            mesh: decision.mesh === true,
            ...(decision.auth === undefined ? {} : { auth: decision.auth }),
          },
          ...(selected === undefined
            ? {}
            : { headers: { "sec-websocket-protocol": selected } satisfies Record<string, string> }),
        })
      ) {
        return undefined;
      }
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      // The line limit is enforced by the framing both transports share, which
      // answers `bad_request` and keeps the connection. This cap only bounds
      // one message's memory, so it sits above the line limit — a message at
      // or under it always reaches the framing and gets that answer.
      maxPayloadLength: MAX_FRAME_BYTES + 64 * 1024,
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
          close: (code, reason) => {
            if (code === undefined) ws.close();
            else ws.close(code, reason);
          },
        });
        const driver = createDriver(conn, options.handle);
        states.set(ws, { conn, queue, reader: new LineReader(driver) });
        options.conns.add(conn);
        const data = ws.data as UpgradeData | undefined;
        options.onConn?.(conn, {
          mesh: data?.mesh === true,
          ...(data?.auth === undefined ? {} : { auth: data.auth }),
        });
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
      // Bounded rather than simply awaited. Measured against Bun 1.3.13: once
      // this server has closed a WebSocket itself — which the mesh does, to
      // drop the loser of a glare, a link gone silent, or a peer speaking out
      // of turn — `stop` never settles, while the address is in fact given up
      // within a millisecond and can be bound again. Waiting on the promise
      // would hang the stop order at its last step for a listener that is
      // already down, so the wait is capped and the address is what is trusted.
      await Promise.race([server.stop(true), Bun.sleep(STOP_DEADLINE_MS)]);
    },
  };
}

/** Where a person's WebSocket is answered, on whatever prefix a proxy puts the
 * instance under. Named here because it is one door, and more than one place
 * has to know what it is called: the entry match below, and the registration
 * URL, which is the same address without it (DR-0001 §2.2). */
export const ENTRY_PATH = "/ws";

/** Whether a request's path is this listener's entry.
 *
 * Matched at the end rather than whole, so a proxy that puts the instance under
 * a prefix of its own passes the request through untouched and an alias URL
 * reaches the same door (DR-0001 §2.7). The boundary before it has to be a
 * separator, or `/notws` would answer for `/ws`. The mesh's own routes are not
 * matched this way: they stay under the configured endpoint, which is what
 * keeps two instances on one origin from answering for each other's keys.
 *
 * The prefix is not read: which instance a proxy meant is settled by which
 * address it forwarded to, and a person's connection names itself by
 * authenticating rather than by the path it arrived on. */
export function entryPath(pathname: string, path: string): boolean {
  return pathname === path || pathname.endsWith(`/${path.replace(/^\//, "")}`);
}

/** How long the stop above waits before trusting the address over the promise.
 * Two orders of magnitude above the millisecond the release was measured at. */
const STOP_DEADLINE_MS = 250;

const NEWLINE = new Uint8Array([0x0a]);
