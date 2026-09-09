import type { Endpoint, Subject } from "@ccmsg/protocol";
import { failure, OpError, reply, type DispatchResult } from "../dispatch/index.ts";
import type { Auth } from "./auth.ts";

/** The three things a person does to passkeys from the machine the instance
 * runs on (DR-0001 §2.2).
 *
 * They are not ops of the contract, and deliberately: the contract is what
 * reaches an instance over a network, and registration is the one thing that
 * must not. These travel on the unix socket alone, where reaching the address
 * is the permission — the same footing the supervisor's own control requests
 * stand on.
 *
 * They arrive as frames that are not ops, which is the shape the mesh handshake
 * already uses for traffic the op vocabulary has no name for. */
export type AdminRequest =
  | {
      readonly admin: "passkey_add";
      readonly request_id: string;
      readonly endpoint?: Endpoint;
      readonly rp_id?: string;
      readonly name?: string;
      readonly sub?: Subject;
    }
  | { readonly admin: "passkey_list"; readonly request_id: string }
  | { readonly admin: "passkey_remove"; readonly request_id: string; readonly sub: Subject };

/** Whether a frame is one of these, without deciding anything about it. */
export function adminRequestOf(frame: unknown): AdminRequest | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const fields = frame as Record<string, unknown>;
  const name = fields["admin"];
  if (name !== "passkey_add" && name !== "passkey_list" && name !== "passkey_remove") {
    return undefined;
  }
  return typeof fields["request_id"] === "string" ? (frame as AdminRequest) : undefined;
}

/** Run one administrative request. */
export function handleAdmin(auth: Auth, request: AdminRequest): DispatchResult {
  try {
    switch (request.admin) {
      case "passkey_add":
        return reply(
          request.request_id,
          auth.issue({
            ...(request.endpoint === undefined ? {} : { endpoint: request.endpoint }),
            ...(request.rp_id === undefined ? {} : { rpId: request.rp_id }),
            ...(request.name === undefined ? {} : { label: request.name }),
            ...(request.sub === undefined ? {} : { sub: request.sub }),
          }),
        );
      case "passkey_list":
        return reply(request.request_id, { credentials: auth.list() });
      case "passkey_remove": {
        const { closed } = auth.remove(request.sub);
        return reply(request.request_id, { sub: request.sub, closed });
      }
    }
  } catch (cause) {
    if (cause instanceof OpError) return failure(request.request_id, cause.code, cause.message);
    return failure(request.request_id, "internal_error", String(cause));
  }
}
