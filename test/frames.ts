import { type OpName, OP_SCHEMAS, type Role, type Sid, validationErrors } from "@ccmsg/protocol";
import { ANONYMOUS, type ConnIdentity, type Requester } from "../src/dispatch/index.ts";

export const SID = "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607";
export const OTHER_SID = "0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b";
export const SELF = "1f0e2d3c4b5a69788796a5b4c3d2e1f0";
export const OTHER_INSTANCE = "00112233445566778899aabbccddeeff";
/** Where `SELF` is reached, for the one field that states a URL rather than an
 * id. Two instances behind one host, which is the shape an id has to survive. */
export const SELF_ENDPOINT = "https://host.example.ts.net/ccmsg/personal/";

/** One accepted argument set per op, so the authorization steps can be swept
 * across the whole attribute table with frames that reach them.
 *
 * These are inputs, not expected outputs: `frames pass the contract` below
 * checks every one against the contract's own request validator, so an
 * argument that drifts from the schema fails here rather than turning a later
 * assertion into a silent `invalid_args`. */
export const REQUEST_ARGS: Record<OpName, Record<string, unknown>> = {
  hello: { role: "user", protocol_version: 3 },
  instance_ping: {},
  instance_shutdown: {},
  session_stopping: {},
  auth_challenge: {},
  auth_register: {
    token: "a-registration-url-token",
    code: "123456",
    credential: {
      id: "Y3JlZGVudGlhbA",
      raw_id: "Y3JlZGVudGlhbA",
      client_data_json: "e30",
      attestation_object: "o2M",
    },
  },
  auth_assert: {
    credential: {
      raw_id: "Y3JlZGVudGlhbA",
      client_data_json: "e30",
      authenticator_data: "YXV0aA",
      signature: "c2ln",
    },
    challenge: { challenge: "Y2hhbGxlbmdl", issuer: SELF, expires_at: 1_757_000_000_000 },
  },
  auth_refresh_token: {},
  auth_refresh: { access_token: "YWNjZXNz" },
  auth_resolve: { kind: "challenge", challenge: "Y2hhbGxlbmdl" },
  auth_rotate: { refresh_token: "cmVmcmVzaA" },

  topic_subscribe: { topic: "peers" },
  topic_unsubscribe: { topic: "peers" },

  message_send: { to: OTHER_SID, text: "hi" },
  say_post: { text: "hi" },
  say_mark_read: {},
  notify_send: { text: "hi" },

  session_kill: { sid: SID },
  session_rename: { sid: SID, title: "a title" },
  session_env_read: { sid: SID },
  session_search: {},
  session_dump_write: { sid: SID },
  transcript_read: { sid: SID },
  session_fork_origin: { sid: SID },
  session_last_live_remove: { sid: SID },

  dir_list: { sid: SID, kind: "workspace" },
  file_read: { sid: SID, kind: "workspace", path: "src/index.ts" },
  file_write: { sid: SID, path: "src/index.ts", content: "" },
  file_create: { sid: SID, kind: "workspace", path: "src/new.ts", content: "" },
  file_edit: {
    sid: SID,
    kind: "workspace",
    path: "src/index.ts",
    content: "",
    expected_mtime_at: 1_757_000_000_000,
    expected_size: 0,
  },
  file_delete: { sid: SID, kind: "workspace", path: "src/gone.ts" },
  file_find: { sid: SID, kind: "workspace", query: "dispatch" },
  file_stat_batch: { sid: SID, paths: ["src/index.ts"] },
  dir_tree: { roots: ["/tmp"] },

  launcher_config_read: {},
  launcher_run: { cwd: "/tmp", params: {} },
  sandbox_grant: { sid: SID, kind: "external", path: "/tmp" },
  sandbox_revoke: { gid: "g1" },
  translate_run: { texts: ["hello"] },
  llm_usage_read: {},
  llm_stats_read: {},

  kv_read: { ns: "ui", key: "layout" },
  kv_write: { ns: "ui", key: "layout", value: 1 },
  kv_delete: { ns: "ui", key: "layout" },
};

/** A whole request frame for an op, with the envelope dispatch requires. */
export function frameFor(op: OpName, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { op, request_id: "1", ...REQUEST_ARGS[op], ...extra };
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
