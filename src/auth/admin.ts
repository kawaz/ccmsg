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
      readonly name?: string;
      readonly sub?: Subject;
    }
  | { readonly admin: "passkey_list"; readonly request_id: string }
  | { readonly admin: "passkey_remove"; readonly request_id: string; readonly sub: Subject }
  /** Stop being a peer of this endpoint, now rather than at the next start.
   *
   * Here with the passkey requests because it is the same kind of thing: what
   * this host is prepared to talk to, said from the machine it runs on, on the
   * socket where reaching the address is the permission. `ccmsg mesh remove`
   * has already taken it off the list; this is the running instance being told
   * so, because a revocation that waited for a restart would leave the link it
   * revoked standing. */
  | { readonly admin: "mesh_forget"; readonly request_id: string; readonly endpoint: Endpoint };

const ADMIN_NAMES = ["passkey_add", "passkey_list", "passkey_remove", "mesh_forget"];

/** Whether a frame is one of these, without deciding anything about it. */
export function adminRequestOf(frame: unknown): AdminRequest | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const fields = frame as Record<string, unknown>;
  if (!ADMIN_NAMES.includes(fields["admin"] as string)) return undefined;
  return typeof fields["request_id"] === "string" ? (frame as AdminRequest) : undefined;
}

/** What an administrative request is asked of: the passkeys, and the mesh on an
 * instance that has one. */
export interface Administered {
  readonly auth: Auth;
  readonly mesh?: { forget(peer: Endpoint): boolean };
}

/** Run one administrative request. */
export function handleAdmin(at: Administered, request: AdminRequest): DispatchResult {
  const auth = at.auth;
  try {
    switch (request.admin) {
      case "mesh_forget": {
        const mesh = at.mesh;
        if (mesh === undefined) {
          return reply(request.request_id, { endpoint: request.endpoint, dropped: false });
        }
        return reply(request.request_id, {
          endpoint: request.endpoint,
          dropped: mesh.forget(request.endpoint),
        });
      }
      case "passkey_add":
        return reply(
          request.request_id,
          auth.issue({
            ...(request.endpoint === undefined ? {} : { endpoint: request.endpoint }),
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
