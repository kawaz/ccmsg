import type { Endpoint } from "@ccmsg/protocol";
import type { MeshJwk } from "./keys.ts";

/** The routes an instance's endpoint stands in front of.
 *
 * An `Endpoint` is the instance's public base URL, ending in a slash and
 * naming no route of its own (contract, `Endpoint`), so everything an instance
 * serves is reached by appending to it. That is also what keeps two instances
 * sharing one origin apart: the key of `https://h/a/` is only ever fetched from
 * below `/a/`, so `https://h/b/` cannot answer for it and a proof made with b's
 * key cannot pass as a's (mesh-peer-auth §6.3). The separation is the shape of
 * the URLs rather than a rule written somewhere. */
const WS_ROUTE = "ws";
const JWK_ROUTE = "mesh/jwk/";

/** Where a peer's mesh link is dialled.
 *
 * The endpoint's own scheme, kept: the link is an HTTP connection upgraded in
 * place, so there is no second scheme to rewrite it into (DR-0001 §2.7). */
export function wsEndpoint(endpoint: Endpoint): string {
  return `${endpoint}${WS_ROUTE}`;
}

/** Where one connection's key is fetched, and the challenge for it left.
 *
 * A plain request rather than a frame on the link, because this is the second
 * connection of §6: the protocol asks that the key be fetched outside the
 * connection being authenticated. */
export function jwkEndpoint(endpoint: Endpoint, kid: string): string {
  return `${endpoint}${JWK_ROUTE}${encodeURIComponent(kid)}`;
}

/** The `kid` a request names, or nothing when the path is not a key request. */
export function kidOfPath(pathname: string, self: Endpoint): string | undefined {
  const prefix = `${new URL(self).pathname}${JWK_ROUTE}`;
  if (!pathname.startsWith(prefix)) return undefined;
  const kid = decodeURIComponent(pathname.slice(prefix.length));
  return kid === "" ? undefined : kid;
}

/** The subprotocol a dialling instance offers.
 *
 * A peer is let through the handshake on this marker alone and proves who it is
 * afterwards, where a claim can actually be checked: an unproven mesh
 * connection is anonymous and can reach only the ops that need no identity at
 * all. What the person\'s entry offers instead is a token bound to a passkey
 * (DR-0001), which is theirs and not an instance\'s to hold. */
export const MESH_PROTOCOL = "ccmsg.mesh";

/** A frame on the mesh link that is not an op.
 *
 * The contract's op vocabulary holds no mesh ops — an op crosses instances by
 * carrying the envelope's mesh fields (contract, `Plane`) — so the handshake's
 * own traffic is spelled apart from it, under a key no request has. */
export type MeshFrame =
  | { readonly mesh: "proof"; readonly jws: string }
  | { readonly mesh: "ping" }
  | { readonly mesh: "pong" };

export function meshFrameOf(frame: unknown): MeshFrame | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const kind = (frame as Record<string, unknown>)["mesh"];
  if (kind === "ping" || kind === "pong") return { mesh: kind };
  if (kind !== "proof") return undefined;
  const jws = (frame as Record<string, unknown>)["jws"];
  return typeof jws === "string" ? { mesh: "proof", jws } : undefined;
}

/** What a key request carries: the challenge the proof must sign (§6). */
export interface JwkRequest {
  readonly ver: number;
  readonly challenge: string;
}

export interface JwkResponse {
  readonly jwk: MeshJwk;
}
