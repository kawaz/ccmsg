import {
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKeyInput,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import type { InstanceId } from "@ccmsg/protocol";

/** The handshake format this instance speaks (mesh-peer-auth §5.3). */
export const MESH_VER = 1;

/** The signature algorithms a proof may be made with.
 *
 * A set rather than one name, because the JWS header is not trusted: the header
 * names an algorithm and this is what decides whether that name may be used at
 * all, which is what stops `alg: none` and algorithm confusion (§5.7-7). Two
 * entries have to be expressible for a migration, so it is a set even while it
 * holds one. */
export const ALLOWED_ALGS: ReadonlySet<string> = new Set(["EdDSA"]);

/** How long a proof stays valid (§5.9). A handshake within one region completes
 * in tens to hundreds of milliseconds, and a peer that cannot manage this could
 * not hold a mesh link anyway. */
export const PROOF_LIFETIME_MS = 10_000;

/** 128 bits, the floor §5.9 sets for both the challenge and the key id: the only
 * requirement on either is that it cannot be predicted. */
const RANDOM_BYTES = 16;

export function randomId(): string {
  return randomBytes(RANDOM_BYTES).toString("hex");
}

/** A public key as it travels: a JWK carrying the id it answers to.
 *
 * The id is on the key because the receiver compares three of them — the
 * greeting's, the proof header's, and this one — and a key that arrived without
 * its own id could not be part of that comparison (§5.7-8). */
export interface MeshJwk {
  readonly kty: string;
  readonly crv?: string;
  readonly x?: string;
  readonly kid: string;
}

/** One connection's signing key.
 *
 * It lives as long as the handshake it was made for: created when the dial
 * starts, fetched once by the peer, and destroyed when the acknowledgement
 * arrives or the connection goes, whichever comes first (§7). Nothing rotates
 * it because nothing outlives one connection. */
export class EphemeralKey {
  readonly kid = randomId();
  readonly #private: KeyObject;
  readonly #public: KeyObject;

  constructor() {
    const pair = generateKeyPairSync("ed25519");
    this.#private = pair.privateKey;
    this.#public = pair.publicKey;
  }

  jwk(): MeshJwk {
    return { ...(this.#public.export({ format: "jwk" }) as object), kid: this.kid } as MeshJwk;
  }

  /** The proof of §5.4: the challenge, and the two endpoint URLs, signed.
   *
   * The URLs are signed even though the greeting already carried them, because
   * the greeting is not signed and therefore states nothing. */
  proof(claim: ProofClaim): string {
    const header = { alg: "EdDSA", kid: this.kid };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
    return `${input}.${sign(null, Buffer.from(input), this.#private).toString("base64url")}`;
  }
}

/** What a proof asserts. */
export interface ProofClaim {
  readonly ver: number;
  readonly iss: InstanceId;
  readonly aud: InstanceId;
  readonly challenge: string;
  /** Unix seconds, as a JWS `exp` is. */
  readonly exp: number;
}

/** A proof that has been read but not yet judged: the header's `kid`, and the
 * claim, both of which the caller compares before any signature is checked. */
export interface ParsedProof {
  readonly kid: string;
  readonly alg: string;
  readonly claim: ProofClaim;
}

export class ProofError extends Error {}

/** Read a compact JWS into its parts, refusing anything malformed or signed
 * with an algorithm outside the allowed set.
 *
 * The algorithm is checked here, before the key is even looked at, because the
 * check exists to decide whether the header may be acted on at all (§5.7-7). */
export function parseProof(jws: string): ParsedProof {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new ProofError("a proof is a compact JWS of three parts");
  const [rawHeader, rawClaim] = parts as [string, string, string];
  const header = decode(rawHeader, "header");
  const alg = header["alg"];
  const kid = header["kid"];
  if (typeof alg !== "string" || !ALLOWED_ALGS.has(alg)) {
    throw new ProofError(`a proof signed with ${String(alg)} is not one this instance accepts`);
  }
  if (typeof kid !== "string" || kid === "") throw new ProofError("a proof names its key");
  const claim = decode(rawClaim, "claim");
  for (const field of ["ver", "iss", "aud", "challenge", "exp"] as const) {
    if (claim[field] === undefined) throw new ProofError(`a proof states its ${field}`);
  }
  return { kid, alg, claim: claim as unknown as ProofClaim };
}

/** Whether the signature was made by the key the JWK carries. */
export function verifyProof(jws: string, jwk: MeshJwk): boolean {
  const parts = jws.split(".");
  if (parts.length !== 3) return false;
  const [rawHeader, rawClaim, rawSignature] = parts as [string, string, string];
  let key: KeyObject;
  try {
    key = createPublicKey({ key: { ...jwk }, format: "jwk" } as JsonWebKeyInput);
  } catch {
    return false;
  }
  return verify(
    null,
    Buffer.from(`${rawHeader}.${rawClaim}`),
    key,
    Buffer.from(rawSignature, "base64url"),
  );
}

function decode(part: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new ProofError(`a proof's ${what} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProofError(`a proof's ${what} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
