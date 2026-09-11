import { helloRole, isHelloOp, MAX_FRAME_BYTES, type Sid } from "@ccmsg/protocol";
import { type DispatchResult, failure, type Requester } from "../dispatch/index.ts";
import type { Conn } from "./conn.ts";

/** What transport calls once a line is a frame. In the instance this is
 * `dispatch` bound to its deps; in tests it is whatever the test needs. */
export interface FrameHandler {
  (frame: unknown, conn: Requester): Promise<DispatchResult>;
}

/** The ops whose reply settles the connection's identity. Transport knows these
 * three op names because binding the identity is its job (DESIGN §2.1);
 * every other op is opaque to it. */

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
      void handle(frame, conn).then(
        (result) => {
          if (result.kind === "none") return;
          settleIfHello(conn, frame, result);
          conn.send(responseOf(result));
          // Whatever the implementation queued for after its reply — the
          // snapshot of a fresh subscription (DESIGN §6.1) — goes out here.
          conn.flushDeferred();
        },
        (cause: unknown) => {
          // The handler settles every refusal of its own into an answer, so a
          // rejection reaching here is this instance failing rather than the
          // caller asking for something wrong.
          conn.send(
            failure(
              requestIdOf(frame),
              "internal_error",
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
          `a request line may not exceed ${MAX_FRAME_BYTES} bytes (got at least ${bytes})`,
        ).response,
      );
    },
  };
}

/** Bind role and sid at the moment a greeting's reply goes out.
 *
 * The role is read from the op that carried the greeting rather than from a
 * field of it: there is one op per role, so the name is the only place the
 * role is said. The frame is safe to read because dispatch only answers
 * `reply` after the op's own schema accepted it, so `sid` — asked for by
 * `hello.session` and by neither of the others — is a sid. */
function settleIfHello(conn: Conn, frame: unknown, result: DispatchResult): void {
  if (result.kind !== "reply") return;
  const fields = frame as Record<string, unknown>;
  const op = fields["op"];
  if (typeof op !== "string" || !isHelloOp(op)) return;
  const sid = fields["sid"];
  conn.settle({
    state: "settled",
    role: helloRole(op),
    ...(typeof sid === "string" ? { sid: sid as Sid } : {}),
  });
}

function responseOf(result: Exclude<DispatchResult, { kind: "none" }>): object {
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
