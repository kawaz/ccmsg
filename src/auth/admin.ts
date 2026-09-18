import type { Base64Url, Endpoint, Origin, UserId } from "@ccmsg/protocol";
import { failure, OpError, reply, type DispatchResult } from "../dispatch/index.ts";
import type { Auth } from "./auth.ts";
import { userIdOf } from "./auth.ts";

/** What a person does to users and passkeys from the machine the instance runs
 * on (DR-0001 §2.2).
 *
 * They are not ops of the contract, and deliberately: the contract is what
 * reaches an instance over a network, and making a person must not. These
 * travel on the unix socket alone, where reaching the address is the permission
 * — the same footing the supervisor's own control requests stand on.
 *
 * They arrive as frames that are not ops, which is the shape the mesh handshake
 * already uses for traffic the op vocabulary has no name for. */
export type AdminRequest =
  | {
      /** Make a person: one enrolment URL, and the grantings that come with
       * it. `user` names somebody who already exists, which makes this a
       * passkey being added to them rather than a new person. */
      readonly admin: "user_create";
      readonly request_id: string;
      readonly origin?: Origin;
      readonly endpoint?: Endpoint;
      /** What to suggest the account be called. */
      readonly name?: string;
      /** The administrator's note about who the URL was handed to. */
      readonly label?: string;
      readonly user?: UserId;
      readonly ttl?: number;
      /** Grant every peer this instance knows of, not only this one. */
      readonly all?: boolean;
    }
  | {
      /** Hand an existing person this instance. Written straight down when the
       * mesh has already carried them here; `enroll` asks for a URL instead,
       * for an instance that has never heard of them. */
      readonly admin: "user_add";
      readonly request_id: string;
      readonly user: UserId;
      readonly all?: boolean;
      readonly enroll?: boolean;
      readonly origin?: Origin;
      readonly endpoint?: Endpoint;
      readonly ttl?: number;
      readonly name?: string;
      readonly label?: string;
    }
  | { readonly admin: "user_list"; readonly request_id: string; readonly user?: UserId }
  | {
      /** Let one person's instance go: this one, or every peer known here. */
      readonly admin: "user_remove";
      readonly request_id: string;
      readonly user: UserId;
      readonly all?: boolean;
    }
  | {
      readonly admin: "user_rename";
      readonly request_id: string;
      readonly user: UserId;
      readonly display_name: string;
    }
  | { readonly admin: "passkey_list"; readonly request_id: string; readonly user: UserId }
  | {
      readonly admin: "passkey_remove";
      readonly request_id: string;
      readonly credential_id: Base64Url;
    }
  /** Stop being a peer of this endpoint, now rather than at the next start.
   *
   * Here with the rest because it is the same kind of thing: what this host is
   * prepared to talk to, said from the machine it runs on, on the socket where
   * reaching the address is the permission. `ccmsg mesh remove` has already
   * taken it off the list; this is the running instance being told so, because
   * a revocation that waited for a restart would leave the link it revoked
   * standing. */
  | { readonly admin: "mesh_forget"; readonly request_id: string; readonly endpoint: Endpoint };

const ADMIN_NAMES = [
  "user_create",
  "user_add",
  "user_list",
  "user_remove",
  "user_rename",
  "passkey_list",
  "passkey_remove",
  "mesh_forget",
];

/** Whether a frame is one of these, without deciding anything about it. */
export function adminRequestOf(frame: unknown): AdminRequest | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const fields = frame as Record<string, unknown>;
  if (!ADMIN_NAMES.includes(fields["admin"] as string)) return undefined;
  return typeof fields["request_id"] === "string" ? (frame as AdminRequest) : undefined;
}

/** What an administrative request is asked of: the people, and the mesh on an
 * instance that has one. */
export interface Administered {
  readonly auth: Auth;
  readonly mesh?: { forget(peer: Endpoint): boolean };
}

/** Run one administrative request. */
export async function handleAdmin(
  at: Administered,
  request: AdminRequest,
): Promise<DispatchResult> {
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
      case "user_create":
        return reply(
          request.request_id,
          await auth.issue({
            purpose: "create_user",
            ...(request.origin === undefined ? {} : { origin: request.origin }),
            ...(request.endpoint === undefined ? {} : { endpoint: request.endpoint }),
            ...(request.name === undefined ? {} : { name: request.name }),
            ...(request.label === undefined ? {} : { label: request.label }),
            ...(request.user === undefined ? {} : { user: userIdOf(request.user) }),
            ...(request.ttl === undefined ? {} : { ttl: request.ttl }),
            ...(request.all === undefined ? {} : { all: request.all }),
          }),
        );
      case "user_add": {
        const user = userIdOf(request.user);
        // A URL is what an instance that has never heard of this person needs:
        // there is nothing here to write a granting against yet, and the
        // assertion is what brings them (contract, DR-0030 §4). Where the mesh
        // has already carried them, the granting is one line and no browser is
        // involved.
        if (request.enroll === true) {
          return reply(
            request.request_id,
            await auth.issue({
              purpose: "add_owner",
              // Named only so the URL can carry what this person is called: an
              // `add_owner` claims no user, since who arrives is what the
              // assertion says (contract, `EnrollClaims`).
              user,
              ...(request.origin === undefined ? {} : { origin: request.origin }),
              ...(request.endpoint === undefined ? {} : { endpoint: request.endpoint }),
              ...(request.name === undefined ? {} : { name: request.name }),
              ...(request.label === undefined ? {} : { label: request.label }),
              ...(request.ttl === undefined ? {} : { ttl: request.ttl }),
              ...(request.all === undefined ? {} : { all: request.all }),
            }),
          );
        }
        // A granting for somebody no user record answers for would be written
        // down and replicated, admitting nobody and indistinguishable from one
        // that means something. Where the mesh has not carried them here yet,
        // the URL is the route that brings them (contract, DR-0030 §4).
        if (auth.records.user(user) === undefined) {
          throw new OpError(
            "not_found",
            `${user} はここでは知られていません。mesh の複製を待つか、--enroll で URL を出してください`,
          );
        }
        const granted = await auth.grant(user, auth.targets(request.all === true), {
          kind: "instance",
          instance: auth.self,
        });
        return reply(request.request_id, { user, granted });
      }
      case "user_list":
        return reply(request.request_id, {
          users: (request.user === undefined
            ? auth.users().map((held) => held.user)
            : [userIdOf(request.user)]
          ).map((user) => auth.account(user)),
        });
      case "user_remove": {
        const user = userIdOf(request.user);
        const released: string[] = [];
        for (const instance of auth.targets(request.all === true)) {
          if (!auth.records.owns(user, instance)) continue;
          await auth.revoke(user, instance);
          released.push(instance);
        }
        if (released.length === 0) {
          throw new OpError("not_found", `${user} が持っている instance はここにありません`);
        }
        return reply(request.request_id, { user, released });
      }
      case "user_rename":
        return reply(
          request.request_id,
          await auth.rename(userIdOf(request.user), request.display_name),
        );
      case "passkey_list":
        return reply(request.request_id, {
          credentials: auth.credentials(userIdOf(request.user)),
        });
      case "passkey_remove": {
        const held = auth.records.credential(request.credential_id);
        if (held === undefined) throw new OpError("not_found", "その passkey はありません");
        await auth.removeCredential(held.user, request.credential_id);
        return reply(request.request_id, { credential_id: held.credential_id, user: held.user });
      }
    }
  } catch (cause) {
    if (cause instanceof OpError) return failure(request.request_id, cause.code, cause.message);
    return failure(request.request_id, "internal_error", String(cause));
  }
}
