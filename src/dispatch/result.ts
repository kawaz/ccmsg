import type { ErrorCode, ErrorResponse, InstanceId } from "@ccmsg/protocol";

/** What dispatch decided about one frame.
 *
 * `forward` is the only outcome that is not an answer: the op belongs to
 * another instance and mesh has to carry it there (DESIGN §2.2 step 6).
 * There is no mesh yet, so dispatch names the destination and stops. */
export type DispatchResult =
  /** The frame was not a request and has no answer. The mesh handshake's own
   * traffic is the only thing that arrives this way: it travels on the
   * connection being authenticated because that is the connection it is about
   * (mesh-peer-auth §5), and the contract's op vocabulary has no name for it. */
  | { readonly kind: "none" }
  | { readonly kind: "reply"; readonly response: Record<string, unknown> }
  | { readonly kind: "error"; readonly response: ErrorResponse }
  | { readonly kind: "forward"; readonly to: InstanceId; readonly frame: Record<string, unknown> };

/** An implementation's refusal, in the contract's own vocabulary.
 *
 * The six steps before a handler answer with codes dispatch derives from the
 * attribute table. The codes an op lists for itself (`topic_unknown` and the
 * like) are known only to the implementation, so it throws this and dispatch
 * turns it into the same error envelope every other refusal uses. */
export class OpError extends Error {
  constructor(
    readonly code: ErrorCode,
    msg: string,
  ) {
    super(msg);
    this.name = "OpError";
  }
}

/** The reply envelope, built here and nowhere else so the wire shape stays in
 * one place (DESIGN §9.1). */
export function reply(
  requestId: string,
  body: unknown,
): Extract<DispatchResult, { kind: "reply" }> {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return { kind: "reply", response: { ok: true, request_id: requestId, ...fields } };
}

export function failure(
  requestId: string | undefined,
  code: ErrorCode,
  msg: string,
): Extract<DispatchResult, { kind: "error" }> {
  const response: ErrorResponse =
    requestId === undefined
      ? { ok: false, error: { code, msg } }
      : {
          ok: false,
          request_id: requestId,
          error: { code, msg },
        };
  return { kind: "error", response };
}
