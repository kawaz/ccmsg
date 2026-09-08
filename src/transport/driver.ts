import type { OpName, Role, Sid } from "@ccmsg/protocol";
import { type ConnIdentity, type DispatchResult, failure } from "../dispatch/index.ts";
import type { Conn } from "./conn.ts";
import { MAX_LINE_BYTES } from "./framing.ts";

/** What transport calls once a line is a frame. In the instance this is
 * `dispatch` bound to its deps; in tests it is whatever the test needs. */
export interface FrameHandler {
  (frame: unknown, identity: ConnIdentity): Promise<DispatchResult>;
}

/** The op whose reply settles the connection's identity. Transport knows this
 * one op name because binding the identity is its job (daemon-v2 §3.1); every
 * other op is opaque to it. */
const HELLO = "hello" satisfies OpName;

/** Drive one connection: a line in, a frame answered on the same connection.
 *
 * The same driver runs for UDS and WS. It holds no framing (that is
 * `LineReader`) and no authorization (that is dispatch) — only the two things
 * that belong to a connection: turning text into a frame, and binding the
 * identity that `hello` establishes. */
export function createDriver(conn: Conn, handle: FrameHandler) {
  return {
    line(text: string): void {
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        conn.send(
          failure(undefined, "bad_request", "a request must be one JSON object per line").response,
        );
        return;
      }
      void handle(frame, conn.identity).then(
        (result) => {
          settleIfHello(conn, frame, result);
          conn.send(responseOf(result));
        },
        (cause: unknown) => {
          conn.send(
            failure(
              requestIdOf(frame),
              "bad_request",
              `the request could not be answered: ${String(cause)}`,
            ).response,
          );
        },
      );
    },

    overflow(bytes: number): void {
      conn.send(
        failure(
          undefined,
          "bad_request",
          `a request line may not exceed ${MAX_LINE_BYTES} bytes (got at least ${bytes})`,
        ).response,
      );
    },
  };
}

/** Bind role and sid at the moment the `hello` reply goes out.
 *
 * The frame is safe to read because dispatch only answers `reply` after the
 * op's own schema accepted it, so `role` is a role and `sid` — required of a
 * session and absent otherwise — is a sid. */
function settleIfHello(conn: Conn, frame: unknown, result: DispatchResult): void {
  if (result.kind !== "reply") return;
  const fields = frame as Record<string, unknown>;
  if (fields["op"] !== HELLO) return;
  const sid = fields["sid"];
  conn.settle({
    state: "settled",
    role: fields["role"] as Role,
    ...(typeof sid === "string" ? { sid: sid as Sid } : {}),
  });
}

function responseOf(result: DispatchResult): object {
  if (result.kind === "forward") {
    // Mesh is what carries a forwarded op to its instance, and there is none
    // yet: the destination exists but nothing can reach it, which is the code
    // the contract gives that outcome.
    const requestId = requestIdOf(result.frame);
    return failure(requestId, "instance_unreachable", `${result.to} cannot be reached`).response;
  }
  return result.response;
}

function requestIdOf(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const id = (frame as Record<string, unknown>)["request_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
