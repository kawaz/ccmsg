import type { ErrorCode, ErrorResponse, InstanceId } from "@ccmsg/protocol";

/** What dispatch decided about one frame.
 *
 * `forward` is the only outcome that is not an answer: the op belongs to
 * another instance and mesh has to carry it there (daemon-v2 §3.2 step 6).
 * There is no mesh yet, so dispatch names the destination and stops. */
export type DispatchResult =
  | { readonly kind: "reply"; readonly response: Record<string, unknown> }
  | { readonly kind: "error"; readonly response: ErrorResponse }
  | { readonly kind: "forward"; readonly to: InstanceId; readonly frame: Record<string, unknown> };

/** The reply envelope, built here and nowhere else so the wire shape stays in
 * one place (daemon-v2 §11.1). */
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
