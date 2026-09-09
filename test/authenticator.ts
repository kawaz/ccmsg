import { createHash, randomBytes } from "node:crypto";
import type { AssertionCredential, RegistrationCredential } from "@ccmsg/protocol";

/** A WebAuthn authenticator in software, for the tests.
 *
 * There is no browser and no Touch ID in a test run, so the two messages an
 * authenticator produces are built here from the same parts a real one uses: an
 * ES256 key pair, the authenticator data the relying party is hashed into, and
 * a signature over it. What it exercises is this instance's verification —
 * every byte it produces goes through the same path a real credential's
 * would. */
export class SoftAuthenticator {
  #keys: CryptoKeyPair | undefined;
  readonly credentialId = new Uint8Array(randomBytes(16));
  signCount = 0;
  /** What the browser writes beside the origin.
   *
   * `undefined` leaves the field out, as Safari does; `false` writes it, as
   * Chromium does on every message. Both are a same-origin exchange and both
   * have to be admitted, which is what having the choice here is for. */
  crossOrigin: boolean | undefined;
  /** Whether the person was verified. An authenticator asked for
   * `userVerification: "required"` always says yes; one that says no is what a
   * relying party has to turn away. */
  userVerified = true;

  constructor(
    readonly rpId: string,
    options: { crossOrigin?: boolean } = {},
  ) {
    this.crossOrigin = options.crossOrigin;
  }

  async #pair(): Promise<CryptoKeyPair> {
    this.#keys ??= (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return this.#keys;
  }

  /** What `navigator.credentials.create()` would have produced. */
  async create(options: { challenge: string; origin: string }): Promise<RegistrationCredential> {
    const jwk = await crypto.subtle.exportKey("jwk", (await this.#pair()).publicKey);
    const cose = encodeCbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, b64(jwk.x as string)],
        [-3, b64(jwk.y as string)],
      ]),
    );
    const authData = this.#authData(true, cose);
    const attestation = encodeCbor(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const id = url(this.credentialId);
    return {
      id,
      raw_id: id,
      client_data_json: url(this.#clientData("webauthn.create", options.challenge, options.origin)),
      attestation_object: url(attestation),
    };
  }

  /** What `navigator.credentials.get()` would have produced. */
  async get(options: { challenge: string; origin: string }): Promise<AssertionCredential> {
    const authData = this.#authData(false);
    const client = this.#clientData("webauthn.get", options.challenge, options.origin);
    const signed = new Uint8Array(authData.length + 32);
    signed.set(authData, 0);
    signed.set(new Uint8Array(createHash("sha256").update(client).digest()), authData.length);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        (await this.#pair()).privateKey,
        signed,
      ),
    );
    return {
      raw_id: url(this.credentialId),
      client_data_json: url(client),
      authenticator_data: url(authData),
      signature: url(der(raw)),
    };
  }

  #clientData(type: string, challenge: string, origin: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        type,
        challenge,
        origin,
        ...(this.crossOrigin === undefined ? {} : { crossOrigin: this.crossOrigin }),
      }),
    );
  }

  /** The authenticator data both messages carry: the relying party, the flags
   * that say a person was present and verified, the counter, and — on a
   * registration — the credential this authenticator just made. */
  #authData(attested: boolean, cose?: Uint8Array): Uint8Array {
    const rpIdHash = new Uint8Array(createHash("sha256").update(this.rpId).digest());
    const head = new Uint8Array(37);
    head.set(rpIdHash, 0);
    head[32] = (attested ? 0x41 : 0x01) | (this.userVerified ? 0x04 : 0x00);
    new DataView(head.buffer).setUint32(33, this.signCount);
    if (!attested || cose === undefined) return head;
    const tail = new Uint8Array(18 + this.credentialId.length + cose.length);
    // The AAGUID is all zeroes: this authenticator makes no statement about
    // what it is, which is exactly what `fmt: "none"` means.
    new DataView(tail.buffer).setUint16(16, this.credentialId.length);
    tail.set(this.credentialId, 18);
    tail.set(cose, 18 + this.credentialId.length);
    const whole = new Uint8Array(head.length + tail.length);
    whole.set(head, 0);
    whole.set(tail, head.length);
    return whole;
  }
}

function url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function b64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** WebCrypto signs ECDSA as the raw pair; WebAuthn carries the ASN.1 sequence,
 * so the test puts it back the way an authenticator would. */
function der(raw: Uint8Array): Uint8Array {
  const part = (bytes: Uint8Array): number[] => {
    let at = 0;
    while (at < bytes.length - 1 && bytes[at] === 0) at += 1;
    const value = [...bytes.subarray(at)];
    if ((value[0] as number) >= 0x80) value.unshift(0);
    return [0x02, value.length, ...value];
  };
  const body = [...part(raw.subarray(0, 32)), ...part(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** Just enough CBOR to write what an authenticator sends. The mirror of the
 * decoder under test, written apart from it so the two cannot agree on a
 * mistake by sharing code. */
function encodeCbor(value: unknown): Uint8Array {
  const out: number[] = [];
  write(value, out);
  return new Uint8Array(out);
}

function write(value: unknown, out: number[]): void {
  if (typeof value === "number") {
    if (value < 0) head(1, -1 - value, out);
    else head(0, value, out);
    return;
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    head(3, bytes.length, out);
    out.push(...bytes);
    return;
  }
  if (value instanceof Uint8Array) {
    head(2, value.length, out);
    out.push(...value);
    return;
  }
  if (value instanceof Map) {
    head(5, value.size, out);
    for (const [key, held] of value) {
      write(key, out);
      write(held, out);
    }
    return;
  }
  throw new Error(`this encoder does not write ${typeof value}`);
}

function head(major: number, argument: number, out: number[]): void {
  if (argument < 24) {
    out.push((major << 5) | argument);
    return;
  }
  if (argument < 0x100) {
    out.push((major << 5) | 24, argument);
    return;
  }
  if (argument < 0x10000) {
    out.push((major << 5) | 25, argument >> 8, argument & 0xff);
    return;
  }
  out.push(
    (major << 5) | 26,
    (argument >>> 24) & 0xff,
    (argument >>> 16) & 0xff,
    (argument >>> 8) & 0xff,
    argument & 0xff,
  );
}
