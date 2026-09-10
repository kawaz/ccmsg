import { type OpName, OP_SCHEMAS, type Role, type Sid, validationErrors } from "@ccmsg/protocol";
import { FIXTURE_IDS, OP_FIXTURES } from "@ccmsg/protocol/fixtures";
import { ANONYMOUS, type ConnIdentity, type Requester } from "../src/dispatch/index.ts";

/** The identifiers the contract's fixtures are built from, so a frame a test
 * builds and a frame the contract states name the same session and instance. */
export const SID: Sid = FIXTURE_IDS.sid;
export const OTHER_SID: Sid = FIXTURE_IDS.other_sid;
export const SELF = FIXTURE_IDS.instance;
export const OTHER_INSTANCE = FIXTURE_IDS.other_instance;
/** Where `SELF` is reached, for the one field that states a URL rather than an
 * id. Two instances behind one host, which is the shape an id has to survive. */
export const SELF_ENDPOINT = FIXTURE_IDS.endpoint;

/** Whether the destination is chosen by the caller rather than by routing.
 *
 * A contract fixture states a representative frame, and for a few ops that
 * includes `to_instance`. Dispatch decides where an op is answered, and the
 * sweeps here ask that of it with the destination left open, so the field is
 * dropped unless a test names one. */
const ROUTED_BY_DISPATCH = "to_instance";

/** A whole request frame for an op, taken from the contract's own fixture so
 * the daemon is swept with the frames the contract states rather than a copy
 * of them. `extra` replaces fields a test needs to differ. */
export function frameFor(op: OpName, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { [ROUTED_BY_DISPATCH]: _routed, ...request } = OP_FIXTURES[op].request as Record<
    string,
    unknown
  >;
  return { ...request, ...extra };
}

/** The contract's own verdict on a frame, used to keep the table above honest. */
export function frameProblems(op: OpName): string[] {
  return validationErrors(OP_SCHEMAS[op].request, frameFor(op));
}

/** A connection outside transport: what dispatch and the topic mechanism need
 * from one, recording what was pushed so a test can read it back. */
export class TestConn implements Requester {
  readonly sent: Record<string, unknown>[] = [];
  readonly #deferred: object[] = [];
  readonly #listeners: (() => void)[] = [];

  constructor(public identity: ConnIdentity = ANONYMOUS) {}

  send(frame: object): void {
    this.sent.push(frame as Record<string, unknown>);
  }

  /** Queued as transport queues it, and released by `flush` where the driver
   * would release it: after the reply to the request in flight. */
  deferSend(frame: object): void {
    this.#deferred.push(frame);
  }

  flush(): void {
    for (const frame of this.#deferred.splice(0)) this.send(frame);
  }

  onClose(listener: () => void): void {
    this.#listeners.push(listener);
  }

  close(): void {
    for (const listener of this.#listeners.splice(0)) listener();
  }

  /** How many close listeners are registered. A connection is long-lived and
   * the listeners are held until it goes, so what registers one per event
   * rather than one per connection accumulates them for as long as it lasts. */
  get listenerCount(): number {
    return this.#listeners.length;
  }

  /** The topic frames pushed so far, which is all a topic test looks at. */
  topics(): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame["ev"] === "topic");
  }
}

/** A connection that has not greeted yet, which is the only kind `hello` is
 * ever answered on: the driver settles the identity from the reply, so the
 * greeting itself always arrives anonymous. */
export function greeting(): TestConn {
  return new TestConn();
}

export function connAs(role: Role, sid: Sid = SID): TestConn {
  return new TestConn({ state: "settled", role, sid });
}
