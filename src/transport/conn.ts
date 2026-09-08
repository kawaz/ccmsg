import {
  ANONYMOUS,
  type ConnIdentity,
  type Requester,
  type SettledIdentity,
} from "../dispatch/index.ts";

/** One accepted connection, as the layers above transport see it.
 *
 * UDS and WS produce this same type, so nothing above transport can tell them
 * apart (daemon-v2 §3.1). Everything that differs between the two — how a line
 * reaches the peer, how a blocked write is retried — is settled behind `send`. */
export interface Conn extends Requester {
  /** Distinguishes connections within one process run. It is not an identity:
   * a connection is anonymous until `hello` settles one. */
  readonly id: number;
  /** Anonymous until `hello` binds a role and, for a session, its sid. */
  readonly identity: ConnIdentity;
  /** Bind the identity `hello` established. Called once, by the transport
   * driver, at the moment the `hello` reply goes out. */
  settle(identity: SettledIdentity): void;
  /** Queue one frame as a line. Ordering is preserved; delivery is
   * best-effort, as it is for any socket that may go away mid-write. */
  send(frame: object): void;
  /** Queue one frame to go out once the reply to the request in flight has.
   * `flushDeferred` is what releases it, and only the driver calls that. */
  deferSend(frame: object): void;
  /** Send everything `deferSend` queued, in the order it was queued. */
  flushDeferred(): void;
  /** Close the underlying socket. Idempotent.
   *
   * A code says why, for the one closure a peer must not read as a fault: the
   * loser of a glare is closed deliberately and is normal at the other end
   * (mesh-peer-auth §8.1). Transports that carry no such code ignore it. */
  close(code?: number, reason?: string): void;
  /** Run when the connection is gone. Anything held per connection — the
   * subscriptions of §6.3 once they exist — is released here, because a closed
   * connection is the only end a subscription has. */
  onClose(listener: () => void): void;
}

/** What a transport implementation supplies for one accepted socket: the two
 * operations that differ between UDS and WS. */
export interface ConnSocket {
  send(line: string): void;
  close(code?: number, reason?: string): void;
}

/** The `Conn` half that is the same for every transport. */
export class BaseConn implements Conn {
  #identity: ConnIdentity = ANONYMOUS;
  #closed = false;
  readonly #listeners: (() => void)[] = [];
  readonly #deferred: object[] = [];

  constructor(
    readonly id: number,
    private readonly socket: ConnSocket,
  ) {}

  get identity(): ConnIdentity {
    return this.#identity;
  }

  settle(identity: SettledIdentity): void {
    this.#identity = identity;
  }

  send(frame: object): void {
    if (this.#closed) return;
    this.socket.send(`${JSON.stringify(frame)}\n`);
  }

  deferSend(frame: object): void {
    this.#deferred.push(frame);
  }

  flushDeferred(): void {
    for (const frame of this.#deferred.splice(0)) this.send(frame);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  onClose(listener: () => void): void {
    if (this.#closed) {
      listener();
      return;
    }
    this.#listeners.push(listener);
  }

  /** Called by the transport when the socket is gone, once. */
  closed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#listeners.splice(0)) listener();
  }
}

/** The connections one instance currently holds.
 *
 * It exists so shutdown (§8.5 step 3) can reach every connection before any
 * listener is closed, and so tests can see that a closed connection is gone. */
export class ConnRegistry {
  readonly #conns = new Set<Conn>();
  #nextId = 1;

  get size(): number {
    return this.#conns.size;
  }

  [Symbol.iterator](): Iterator<Conn> {
    return this.#conns[Symbol.iterator]();
  }

  nextId(): number {
    return this.#nextId++;
  }

  add(conn: Conn): void {
    this.#conns.add(conn);
  }

  remove(conn: Conn): void {
    this.#conns.delete(conn);
  }
}
