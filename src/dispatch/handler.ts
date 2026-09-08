import type { OpName, Role } from "@ccmsg/protocol";
import type { ConnIdentity, SettledIdentity } from "./identity.ts";

/** The connection a request arrived on, as an implementation sees it.
 *
 * It is the `Conn` transport accepted, narrowed to what an op may do with it:
 * read the identity, push frames, and learn that the connection is gone. A
 * subscription is held by a connection and ends with it (daemon-v2 §6.3), so
 * this is what the topic mechanism keys its subscribers on. Declared here
 * rather than imported from transport because dispatch sits below it. */
export interface Requester {
  readonly identity: ConnIdentity;
  /** Push one frame that is not a reply — a topic frame or a connection event. */
  send(frame: object): void;
  /** Push one frame after the reply to the request being handled goes out, so
   * a subscribe's snapshot follows its acknowledgement rather than preceding it. */
  deferSend(frame: object): void;
  onClose(listener: () => void): void;
}

/** What an op implementation receives.
 *
 * The arguments are already validated and the caller is already allowed
 * (daemon-v2 §3.2): a handler starts from "this may be run", so it holds no
 * check of its own. */
export interface HandlerInput {
  readonly op: OpName;
  /** The connection the request arrived on. Ops that hold something for the
   * length of a connection — the subscriptions of daemon-v2 §6.3 — need it;
   * ops that only answer ignore it. */
  readonly conn: Requester;
  /** The whole request frame, validated against the op's request schema. */
  readonly args: Record<string, unknown>;
  /** The connection's identity, absent for the two ops that run before `hello`. */
  readonly identity?: SettledIdentity;
  /** Set only for ops the attribute table marks `scope: "role"`, where the role
   * changes what the reply may contain rather than whether the call is allowed.
   * This is the only route by which a role reaches an implementation
   * (daemon-v2 §3.2). */
  readonly role?: Role;
}

/** An op implementation. It answers with the op's response body (dispatch adds
 * `ok` and `request_id`, so the body never carries the reply's envelope), and
 * may answer with a promise of one — dispatch awaits what it returns. */
export type OpHandler = (input: HandlerInput) => unknown;

/** One handler per op in the contract. The record is total on purpose: an op
 * added to the attribute table does not compile until it has an implementation
 * reachable through dispatch (M1). */
export type Handlers = Readonly<Record<OpName, OpHandler>>;
