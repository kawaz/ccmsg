import { type OpName, OP_SCHEMAS, type Role, type Sid, validationErrors } from "@ccmsg/protocol";
import { ANONYMOUS, type ConnIdentity, type Requester } from "../src/dispatch/index.ts";

export const SID = "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607";
export const OTHER_SID = "0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b";
export const SELF = "wss://host.example.ts.net/ccmsg/personal";
export const OTHER_INSTANCE = "wss://host.example.ts.net/ccmsg/other";

/** One accepted argument set per op, so the authorization steps can be swept
 * across the whole attribute table with frames that reach them.
 *
 * These are inputs, not expected outputs: `frames pass the contract` below
 * checks every one against the contract's own request validator, so an
 * argument that drifts from the schema fails here rather than turning a later
 * assertion into a silent `invalid_args`. */
export const REQUEST_ARGS: Record<OpName, Record<string, unknown>> = {
  hello: { role: "user", protocol_version: 2 },
  instance_ping: {},
  instance_shutdown: {},
  session_stopping: {},
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
