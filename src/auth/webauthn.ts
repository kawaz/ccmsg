import { createHash, timingSafeEqual } from "node:crypto";
import type { AssertionCredential, Base64Url, RegistrationCredential } from "@ccmsg/protocol";
import { type CborValue, decodeCbor, decodeCborWhole, mapEntry } from "./cbor.ts";

/** Why a registration or an assertion was refused.
 *
 * One class for all of them because the caller does one thing with any of
 * them: answers `auth_invalid`. The message says which step failed, for the
 * log; nothing branches on it. */
export class WebAuthnError extends Error {}

/** The flags of the authenticator data (L2 §6.1). Only two are read: that a
 * person was present, and that they were verified — the registration asks for
 * `userVerification: "required"`, so both have to hold on every exchange. */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

export function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function base64UrlEncode(bytes: Uint8Array): Base64Url {
  return Buffer.from(bytes).toString("base64url");
}

export function sha256(bytes: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** What the browser said about the exchange it ran, as the parts that are
 * checked here. Fields beyond these are left alone: a browser may add them,
 * and the two that must be absent are refused by name below. */
interface ClientData {
  readonly type?: unknown;
  readonly challenge?: unknown;
  readonly origin?: unknown;
  readonly crossOrigin?: unknown;
  readonly topOrigin?: unknown;
}

/** The authenticator data, as far as it is read (L2 §6.1). */
export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: number;
  readonly signCount: number;
  /** Present on a registration, absent on an assertion. */
  readonly credentialId?: Uint8Array;
  /** The COSE key, exactly the bytes it occupied, so it is stored as it came. */
  readonly publicKey?: Uint8Array;
}

export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new WebAuthnError("the authenticator data is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rpIdHash = bytes.subarray(0, 32);
  const flags = bytes[32] as number;
  const signCount = view.getUint32(33);
  if ((flags & FLAG_ATTESTED_CREDENTIAL) === 0) return { rpIdHash, flags, signCount };
  if (bytes.length < 55) throw new WebAuthnError("the attested credential data is too short");
  const idLength = view.getUint16(53);
  const idEnd = 55 + idLength;
  if (bytes.length < idEnd) throw new WebAuthnError("the credential id runs past the end");
  const credentialId = bytes.subarray(55, idEnd);
  // The key is followed by extensions when there are any, so its own length is
  // what the decoder reports rather than what is left in the buffer.
  const rest = bytes.subarray(idEnd);
  let after: number;
  try {
    ({ rest: after } = decodeCbor(rest));
  } catch (cause) {
    throw new WebAuthnError(`the credential's public key could not be read: ${String(cause)}`);
  }
  const publicKey = rest.subarray(0, rest.length - after);
  return { rpIdHash, flags, signCount, credentialId, publicKey };
}

/** What the two exchanges check in common (L2 §7.1 steps 7-11, §7.2 steps
 * 11-15): what the browser was doing, which challenge it answered, which page
 * asked, and that the answer belongs to one page rather than an embedded one.
 *
 * The origin is compared against the set the operator configured for the web
 * UI rather than against the endpoint: the endpoint is where the instance is
 * dialed, and the page may be served from another name under the same
 * registrable domain (DR-0001 §2.3). */
export function checkClientData(
  clientDataJson: Uint8Array,
  expected: { type: string; challenge: string; origins: readonly string[] },
): void {
  let parsed: ClientData;
  try {
    parsed = JSON.parse(new TextDecoder().decode(clientDataJson)) as ClientData;
  } catch (cause) {
    throw new WebAuthnError(`the client data is not JSON: ${String(cause)}`);
  }
  if (parsed.type !== expected.type) {
    throw new WebAuthnError(`the client data is for ${String(parsed.type)}`);
  }
  if (typeof parsed.challenge !== "string" || !equalStrings(parsed.challenge, expected.challenge)) {
    throw new WebAuthnError("the client data answers another challenge");
  }
  if (typeof parsed.origin !== "string" || !expected.origins.includes(parsed.origin)) {
    throw new WebAuthnError(`${String(parsed.origin)} is not an origin this instance serves`);
  }
  // What is refused is an exchange an embedding page ran, which is what either
  // of these says when it is there to say it. `crossOrigin: false` is not that:
  // Chromium writes the field on every message, and reading its presence as the
  // refusal would turn away every credential those browsers make. `topOrigin`
  // is only ever written when the exchange was cross-origin, so its presence at
  // all is the refusal.
  if (parsed.crossOrigin === true || parsed.topOrigin !== undefined) {
    throw new WebAuthnError("this exchange must not be run from an embedded page");
  }
}

/** The relying party and the person, as every exchange states them.
 *
 * Several relying parties may be named on an assertion, because a credential
 * does not say which one it was made for and this instance may serve more than
 * one name. Each is one the operator configured; nothing is widened here. */
export function checkAuthenticator(data: AuthenticatorData, rpIds: readonly string[]): void {
  if (!rpIds.some((rpId) => equalBytes(data.rpIdHash, sha256(rpId)))) {
    throw new WebAuthnError("the authenticator answered for another relying party");
  }
  if ((data.flags & FLAG_USER_PRESENT) === 0) throw new WebAuthnError("no person was present");
  if ((data.flags & FLAG_USER_VERIFIED) === 0) throw new WebAuthnError("no person was verified");
}

/** What a verified registration leaves behind, as the record keeps it. */
export interface VerifiedRegistration {
  readonly credentialId: Base64Url;
  readonly publicKey: Base64Url;
  readonly signCount: number;
}

/** Check a registration (L2 §7.1) and answer what is worth keeping.
 *
 * Attestation is `none` by the request the page makes, so what this reads out
 * of the attestation object is the authenticator data and the key — there is no
 * statement about the hardware to verify, and one that arrived would mean the
 * page asked for something other than what this instance asked it to. */
export function verifyRegistration(
  credential: RegistrationCredential,
  expected: { challenge: string; origins: readonly string[]; rpId: string },
): VerifiedRegistration {
  checkClientData(base64UrlDecode(credential.client_data_json), {
    type: "webauthn.create",
    challenge: expected.challenge,
    origins: expected.origins,
  });
  let attestation: CborValue;
  try {
    attestation = decodeCborWhole(base64UrlDecode(credential.attestation_object));
  } catch (cause) {
    throw new WebAuthnError(`the attestation object could not be read: ${String(cause)}`);
  }
  if (mapEntry(attestation, "fmt") !== "none") {
    throw new WebAuthnError("this instance registers credentials without attestation");
  }
  const statement = mapEntry(attestation, "attStmt");
  if (!(statement instanceof Map) || statement.size !== 0) {
    throw new WebAuthnError("an unattested registration carries an empty statement");
  }
  const authData = mapEntry(attestation, "authData");
  if (!(authData instanceof Uint8Array)) {
    throw new WebAuthnError("the attestation object carries no authenticator data");
  }
  const data = parseAuthenticatorData(authData);
  checkAuthenticator(data, [expected.rpId]);
  if (data.credentialId === undefined || data.publicKey === undefined) {
    throw new WebAuthnError("the registration carries no credential");
  }
  // The id the browser reported and the one the authenticator signed are the
  // same value by construction; comparing them is what says the two halves of
  // the message describe one credential.
  if (!equalBytes(data.credentialId, base64UrlDecode(credential.raw_id))) {
    throw new WebAuthnError("the credential named is not the one attested");
  }
  return {
    credentialId: base64UrlEncode(data.credentialId),
    publicKey: base64UrlEncode(data.publicKey),
    signCount: data.signCount,
  };
}

/** Check an assertion (L2 §7.2) against the key a registration left behind. */
export async function verifyAssertion(
  credential: AssertionCredential,
  known: { publicKey: Base64Url; signCount?: number },
  expected: { challenge: string; origins: readonly string[]; rpIds: readonly string[] },
): Promise<{ signCount: number }> {
  const clientDataJson = base64UrlDecode(credential.client_data_json);
  checkClientData(clientDataJson, {
    type: "webauthn.get",
    challenge: expected.challenge,
    origins: expected.origins,
  });
  const authData = base64UrlDecode(credential.authenticator_data);
  const data = parseAuthenticatorData(authData);
  checkAuthenticator(data, expected.rpIds);
  // A synced passkey reports zero forever, and an authenticator that keeps a
  // counter only ever counts up. So once a non-zero reading has been recorded,
  // every later one has to be higher — including a zero, which from an
  // authenticator that was counting is a different device answering with a copy
  // of the credential.
  const last = known.signCount ?? 0;
  if (last !== 0 && data.signCount <= last) {
    throw new WebAuthnError("the authenticator's counter did not advance");
  }
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData, 0);
  signed.set(sha256(clientDataJson), authData.length);
  const ok = await verifySignature(
    base64UrlDecode(known.publicKey),
    signed,
    base64UrlDecode(credential.signature),
  );
  if (!ok) throw new WebAuthnError("the signature is not this credential's");
  return { signCount: data.signCount };
}

/** The three algorithms a credential may be created with, as the page asks for
 * them, and what each is to WebCrypto. */
const ES256 = -7;
const EdDSA = -8;
const RS256 = -257;

export const SUPPORTED_ALGORITHMS: readonly number[] = [ES256, EdDSA, RS256];

/** Import the COSE key a registration carried, so a record is never written
 * around a key nothing can verify with.
 *
 * Done at registration rather than at the first assertion: a key that cannot be
 * imported is a credential that can never be used, and finding that out when
 * the person tries to sign in leaves a record nobody can explain. The imported
 * key itself is thrown away — an assertion imports its own (§2.10). */
export async function checkPublicKey(cose: Uint8Array): Promise<void> {
  const key = decodeCborWhole(cose);
  const alg = mapEntry(key, 3);
  if (typeof alg !== "number" || !SUPPORTED_ALGORITHMS.includes(alg)) {
    throw new WebAuthnError("the key names no algorithm this instance verifies");
  }
  await importPublicKey(key, alg);
}

/** Verify one signature against a COSE key.
 *
 * The key is imported per verification rather than kept: an assertion arrives
 * once every few hours at most, and holding a `CryptoKey` per credential would
 * be a cache of something that is cheap to make and has to be invalidated when
 * the credential is removed. */
async function verifySignature(
  cose: Uint8Array,
  signed: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const key = decodeCborWhole(cose);
  const alg = mapEntry(key, 3);
  if (typeof alg !== "number" || !SUPPORTED_ALGORITHMS.includes(alg)) {
    throw new WebAuthnError("the key names no algorithm this instance verifies");
  }
  const imported = await importPublicKey(key, alg);
  if (alg === ES256) {
    // WebAuthn signs ES256 as the ASN.1 sequence X.509 uses, while WebCrypto
    // verifies the raw pair, so the two halves are taken out of the DER here.
    const raw = rawEcdsaSignature(signature);
    if (raw === undefined) return false;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      imported,
      owned(raw),
      owned(signed),
    );
  }
  const algorithm = alg === EdDSA ? { name: "Ed25519" } : { name: "RSASSA-PKCS1-v1_5" };
  return await crypto.subtle.verify(algorithm, imported, owned(signature), owned(signed));
}

/** The COSE key as WebCrypto holds it. A key whose parts are missing or the
 * wrong shape fails here, which is where both the registration and every
 * assertion find out. */
async function importPublicKey(key: CborValue, alg: number): Promise<CryptoKey> {
  switch (alg) {
    case ES256: {
      if (mapEntry(key, 1) !== 2) throw new WebAuthnError("an ES256 key is an EC2 key");
      if (mapEntry(key, -1) !== 1) throw new WebAuthnError("an ES256 key is on P-256");
      const x = bytesAt(key, -2, 32);
      const y = bytesAt(key, -3, 32);
      return await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: base64UrlEncode(x), y: base64UrlEncode(y) },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    }
    case EdDSA: {
      if (mapEntry(key, 1) !== 1) throw new WebAuthnError("an EdDSA key is an OKP key");
      if (mapEntry(key, -1) !== 6) throw new WebAuthnError("an EdDSA key is on Ed25519");
      const x = bytesAt(key, -2, 32);
      return await crypto.subtle.importKey(
        "jwk",
        { kty: "OKP", crv: "Ed25519", x: base64UrlEncode(x) },
        { name: "Ed25519" },
        false,
        ["verify"],
      );
    }
    default: {
      if (mapEntry(key, 1) !== 3) throw new WebAuthnError("an RS256 key is an RSA key");
      const n = bytesAt(key, -1);
      const e = bytesAt(key, -2);
      return await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: base64UrlEncode(n), e: base64UrlEncode(e) },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    }
  }
}

/** A copy backed by a buffer of its own.
 *
 * Every value here is a view into the frame it was decoded from, and WebCrypto
 * takes only a view that owns its buffer. The copy is a few dozen bytes and
 * happens once per verification. */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

function bytesAt(key: CborValue, label: number, width?: number): Uint8Array {
  const held = mapEntry(key, label);
  if (!(held instanceof Uint8Array)) {
    throw new WebAuthnError(`the key carries no ${String(label)}`);
  }
  if (width !== undefined && held.length !== width) {
    throw new WebAuthnError(`the key's ${String(label)} is not ${String(width)} bytes`);
  }
  return held;
}

/** The `r` and `s` of a DER-encoded ECDSA signature, each padded to 32 bytes.
 *
 * Nothing is trusted about the lengths: a signature is attacker-supplied until
 * it verifies, so a structure that does not parse is a refusal rather than an
 * exception. */
function rawEcdsaSignature(der: Uint8Array): Uint8Array | undefined {
  if (der[0] !== 0x30) return undefined;
  let at = 2;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < 2; i += 1) {
    if (der[at] !== 0x02) return undefined;
    const length = der[at + 1];
    if (length === undefined) return undefined;
    const start = at + 2;
    const end = start + length;
    if (end > der.length) return undefined;
    let part = der.subarray(start, end);
    // A leading zero is the DER sign byte; a shorter value is left-padded.
    while (part.length > 32 && part[0] === 0) part = part.subarray(1);
    if (part.length > 32) return undefined;
    parts.push(part);
    at = end;
  }
  const raw = new Uint8Array(64);
  raw.set(parts[0] as Uint8Array, 32 - (parts[0] as Uint8Array).length);
  raw.set(parts[1] as Uint8Array, 64 - (parts[1] as Uint8Array).length);
  return raw;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Compare two secrets without saying where they diverged.
 *
 * Every value compared this way — a challenge, a token, a six-digit code — is
 * one a caller may be guessing, and a comparison that returns at the first
 * difference tells them how far they got. */
export function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
