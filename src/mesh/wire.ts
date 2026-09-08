import type { InstanceId } from "@ccmsg/protocol";
import type { MeshJwk } from "./keys.ts";

/** The paths an instance's endpoint URL stands in front of.
 *
 * An `InstanceId` is compared whole, path included (contract, `InstanceId`), so
 * everything an instance serves hangs below it. That is also what keeps two
 * instances sharing one origin apart: the key of `wss://h/a` is only ever
 * fetched from below `/a`, so `wss://h/b` cannot answer for it and a proof made
 * with b's key cannot pass as a's (mesh-peer-auth §6.3). The separation is the
 * shape of the URLs rather than a rule written somewhere. */
const WS_PATH = "/ws";
const JWK_PATH = "/mesh/jwk/";
const PROBE_PATH = "/mesh/probe";

/** Where a peer's mesh link is dialled. */
export function wsEndpoint(id: InstanceId): string {
  return `${id}${WS_PATH}`;
}

/** Where one connection's key is fetched, and the challenge for it left.
 *
 * `http` rather than `ws` because this is the second connection of §6, which
 * carries one request and closes: the protocol asks that it be a connection of
 * its own outside the one being authenticated, not that it be a WebSocket. */
export function jwkEndpoint(id: InstanceId, kid: string): string {
  return `${httpBase(id)}${JWK_PATH}${encodeURIComponent(kid)}`;
}

export function probeEndpoint(id: InstanceId): string {
  return `${httpBase(id)}${PROBE_PATH}`;
}

/** The `kid` a request names, or nothing when the path is not a key request. */
export function kidOfPath(pathname: string, self: InstanceId): string | undefined {
  const prefix = `${new URL(self).pathname.replace(/\/$/, "")}${JWK_PATH}`;
  if (!pathname.startsWith(prefix)) return undefined;
  const kid = decodeURIComponent(pathname.slice(prefix.length));
  return kid === "" ? undefined : kid;
}

export function isProbePath(pathname: string, self: InstanceId): boolean {
  return pathname === `${new URL(self).pathname.replace(/\/$/, "")}${PROBE_PATH}`;
}

/** The same authority and path, reached over HTTP. A `ws` URL and the `http`
 * one beside it are one server; the scheme differs and nothing else does. */
function httpBase(id: InstanceId): string {
  const url = new URL(id);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.href.replace(/\/$/, "");
}

/** The subprotocol a dialling instance offers.
 *
 * The entry token gates the WebSocket because anything that can open a TCP
 * connection to the address can try it (§3.1). A peer cannot hold that token —
 * it is one instance's own handle, kept 0600, and giving it to every peer would
 * make it the mesh's shared password. So a peer is let past the handshake on
 * this marker alone and proves who it is afterwards, where a claim can actually
 * be checked: an unproven mesh connection is anonymous and can reach only the
 * ops that need no identity at all. */
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

/** What a self-identification probe carries (mesh-self-identification §5.1). */
export interface ProbeBody {
  readonly ver: number;
  readonly token: string;
}
