import { BaseConn, type Conn, type ConnRegistry } from "./conn.ts";

export interface DialOptions {
  readonly url: string;
  readonly protocols?: readonly string[];
  readonly conns: ConnRegistry;
  /** One frame the far end wrote. A dialled connection is one this instance
   * speaks on rather than one it serves, so what arrives is answered by whoever
   * dialled rather than by dispatch. */
  readonly onFrame: (frame: unknown, conn: Conn) => void;
  /** Why the connection ended, as the far end stated it. The code is what
   * separates a closure that is a fault from one that is the other end's
   * normal course (mesh-peer-auth §8.1). */
  readonly onClose?: (code: number) => void;
}

/** A connection this instance opened, as the same `Conn` an accepted one is.
 *
 * daemon-v2 §3.1 has one connection type above transport, and a mesh link is a
 * connection of that layer whichever end dialled it: the two differ in who
 * opened the socket and in nothing the layers above can see. */
export async function dialWs(options: DialOptions): Promise<Conn> {
  const ws =
    options.protocols === undefined
      ? new WebSocket(options.url)
      : new WebSocket(options.url, [...options.protocols]);
  const conn = new BaseConn(options.conns.nextId(), {
    send: (line) => {
      ws.send(line);
    },
    close: (code, reason) => {
      if (code === undefined) ws.close();
      else ws.close(code, reason);
    },
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve();
    });
    ws.addEventListener("error", () => {
      reject(new Error(`${options.url} did not accept a connection`));
    });
  });
  options.conns.add(conn);
  ws.addEventListener("message", (event: MessageEvent) => {
    // One message is one frame here, as it is on the accepting side, and the
    // far end writes whole lines.
    for (const line of String(event.data).split("\n")) {
      if (line.trim() === "") continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      options.onFrame(frame, conn);
    }
  });
  ws.addEventListener("close", (event: CloseEvent) => {
    options.conns.remove(conn);
    conn.closed();
    options.onClose?.(event.code);
  });
  return conn;
}
