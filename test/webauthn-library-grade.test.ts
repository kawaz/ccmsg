import { describe, expect, test } from "bun:test";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AssertionCredential, RegistrationCredential } from "@ccmsg/protocol";
import {
  base64UrlDecode,
  base64UrlEncode,
  checkPublicKey,
  decodeCborWhole,
  parseAuthenticatorData,
  sha256,
  verifyAssertion,
  verifyRegistration,
} from "../src/auth/index.ts";
import { SoftAuthenticator, type SoftAlgorithm } from "./authenticator.ts";

/** 該当なし: 時間境界は CBOR と署名の純粋な検証には存在しない。challenge の期限は発行者の Auth で別に検証する。 */
const origin = "https://ui.example";
const rpId = "ui.example";
const challenge = "Y2hhbGxlbmdlLXdpdGgtZW50cm9weQ";
const expectedRegistration = { challenge, origin, rpId };
const expectedAssertion = { challenge, origin, rpIds: [rpId] };

function encode(value: unknown): Uint8Array {
  const bytes: number[] = [];
  const head = (major: number, length: number): void => {
    if (length < 24) bytes.push((major << 5) | length);
    else if (length < 256) bytes.push((major << 5) | 24, length);
    else if (length < 65536) bytes.push((major << 5) | 25, length >> 8, length & 255);
    else
      bytes.push(
        (major << 5) | 26,
        (length >>> 24) & 255,
        (length >>> 16) & 255,
        (length >>> 8) & 255,
        length & 255,
      );
  };
  const write = (part: unknown): void => {
    if (typeof part === "number") {
      head(part < 0 ? 1 : 0, part < 0 ? -1 - part : part);
      return;
    }
    if (typeof part === "string") {
      const text = new TextEncoder().encode(part);
      head(3, text.length);
      bytes.push(...text);
      return;
    }
    if (part instanceof Uint8Array) {
      head(2, part.length);
      bytes.push(...part);
      return;
    }
    if (part instanceof Map) {
      head(5, part.size);
      for (const [key, item] of part) {
        write(key);
        write(item);
      }
      return;
    }
    throw new Error("test encoder accepts only WebAuthn CBOR values");
  };
  write(value);
  return Uint8Array.from(bytes);
}

function attestation(authData: Uint8Array, fmt = "none", statement = new Map()): string {
  return base64UrlEncode(
    encode(
      new Map<string, unknown>([
        ["fmt", fmt],
        ["attStmt", statement],
        ["authData", authData],
      ]),
    ),
  );
}

async function registration(algorithm: SoftAlgorithm = "ES256") {
  const authenticator = new SoftAuthenticator(rpId, { algorithm });
  const credential = await authenticator.create({ challenge, origin });
  const decoded = decodeCborWhole(base64UrlDecode(credential.attestation_object)) as Map<
    string,
    Uint8Array
  >;
  const data = Uint8Array.from(decoded.get("authData") as Uint8Array);
  const replace = (authData: Uint8Array): RegistrationCredential => ({
    ...credential,
    attestation_object: attestation(authData),
  });
  return { authenticator, credential, data, replace };
}

function clientData(
  credential: AssertionCredential,
  fields: Record<string, unknown>,
): AssertionCredential {
  const original = JSON.parse(
    Buffer.from(credential.client_data_json, "base64url").toString(),
  ) as Record<string, unknown>;
  return {
    ...credential,
    client_data_json: base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ ...original, ...fields })),
    ),
  };
}

async function accept(check: () => unknown): Promise<boolean> {
  try {
    const result = await check();
    return !(
      typeof result === "object" &&
      result !== null &&
      "verified" in result &&
      result.verified === false
    );
  } catch {
    return false;
  }
}

function libraryRegistration(credential: RegistrationCredential) {
  return verifyRegistrationResponse({
    response: {
      id: credential.id,
      rawId: credential.raw_id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: credential.client_data_json,
        attestationObject: credential.attestation_object,
      },
    },
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
  });
}

function libraryAssertion(credential: AssertionCredential, publicKey: string, counter: number) {
  return verifyAuthenticationResponse({
    response: {
      id: credential.raw_id,
      rawId: credential.raw_id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: credential.client_data_json,
        authenticatorData: credential.authenticator_data,
        signature: credential.signature,
        ...(credential.user_handle === undefined ? {} : { userHandle: credential.user_handle }),
      },
    },
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    credential: {
      id: credential.raw_id,
      publicKey: Uint8Array.from(base64UrlDecode(publicKey)),
      counter,
    },
  });
}

describe("登録の none attestation と attested credential data", () => {
  test("WebAuthn Level 2 §6.5.1.1 の固定 COSE EC2 鍵を解釈し WebCrypto に渡せる", async () => {
    // 出典: W3C Web Authentication Level 2 §6.5.1.1, example-08d0b440 (W3C Document License)。公開鍵の座標と CBOR の符号化を独立した既知値として固定する。
    const hex =
      "a5 01 02 03 26 20 01 21 58 20 65eda5a12577c2bae829437fe338701a10aaa375e1bb5b5de108de439c08551d 22 58 20 1e52ed75701163f7f9e40ddf9f341b3dc9ba860af7e0ca7ca7e9eecd0084d19c";
    const bytes = Uint8Array.from(Buffer.from(hex.replaceAll(" ", ""), "hex"));
    const key = decodeCborWhole(bytes) as Map<number, unknown>;
    expect(key.get(1)).toBe(2);
    expect(key.get(3)).toBe(-7);
    expect(key.get(-1)).toBe(1);
    expect(Buffer.from(key.get(-2) as Uint8Array).toString("hex")).toBe(
      "65eda5a12577c2bae829437fe338701a10aaa375e1bb5b5de108de439c08551d",
    );
    expect(Buffer.from(key.get(-3) as Uint8Array).toString("hex")).toBe(
      "1e52ed75701163f7f9e40ddf9f341b3dc9ba860af7e0ca7ca7e9eecd0084d19c",
    );
    expect(await checkPublicKey(bytes)).toBeUndefined();
  });

  test("authData の固定ヘッダ、AAGUID、credential ID と COSE 鍵の境界を切り分ける", async () => {
    const { credential, data } = await registration();
    const parsed = parseAuthenticatorData(data);
    expect(parsed.rpIdHash).toEqual(sha256(rpId));
    expect(parsed.flags & 0x45).toBe(0x45);
    expect(parsed.signCount).toBe(0);
    expect(data.subarray(37, 53)).toEqual(new Uint8Array(16));
    expect(new DataView(data.buffer).getUint16(53)).toBe(16);
    expect(parsed.credentialId).toEqual(base64UrlDecode(credential.raw_id));
    expect(parsed.publicKey?.length).toBeGreaterThan(0);
    expect(verifyRegistration(credential, expectedRegistration).publicKey).toBe(
      base64UrlEncode(parsed.publicKey as Uint8Array),
    );
  });

  test("counter の 0 と最大値、任意の AAGUID は ID や鍵の位置を変えない", async () => {
    const { data, replace } = await registration();
    for (const count of [0, 0xffffffff]) {
      const changed = Uint8Array.from(data);
      new DataView(changed.buffer).setUint32(33, count);
      changed.fill(0xa5, 37, 53);
      expect(verifyRegistration(replace(changed), expectedRegistration).signCount).toBe(count);
      expect(parseAuthenticatorData(changed).credentialId).toEqual(data.subarray(55, 71));
    }
  });

  test("ID 長が 0、1、最大値を名乗るとき、終端を越す長さだけは拒否する", async () => {
    const { data, replace } = await registration();
    for (const length of [0, 1, 16, 65535]) {
      const changed = Uint8Array.from(data);
      new DataView(changed.buffer).setUint16(53, length);
      if (length === 16)
        expect(
          verifyRegistration(replace(changed), expectedRegistration).credentialId,
        ).toBeDefined();
      else expect(() => verifyRegistration(replace(changed), expectedRegistration)).toThrow();
    }
    expect(() => parseAuthenticatorData(data.subarray(0, 54))).toThrow(
      /attested credential data is too short/,
    );
    expect(() => parseAuthenticatorData(data.subarray(0, 55 + 15))).toThrow(
      /credential id runs past the end/,
    );
  });

  async function registrationWithIdLength(length: number): Promise<RegistrationCredential> {
    const { data, replace } = await registration();
    const publicKey = data.subarray(71);
    const id = data.subarray(55, 55 + length);
    const changed = new Uint8Array(55 + length + publicKey.length);
    changed.set(data.subarray(0, 55));
    new DataView(changed.buffer).setUint16(53, length);
    changed.set(id, 55);
    changed.set(publicKey, 55 + length);
    return { ...replace(changed), id: base64UrlEncode(id), raw_id: base64UrlEncode(id) };
  }

  test("1 byte の credential ID を正しい長さと鍵位置で組み直して両検証器を比較する", async () => {
    const candidate = await registrationWithIdLength(1);
    expect(await accept(() => verifyRegistration(candidate, expectedRegistration))).toBe(true);
    expect(await accept(() => libraryRegistration(candidate))).toBe(true);
  });

  test("空の credential ID は両検証器が拒否する (認証で指せない鍵を記録しないため)", async () => {
    const candidate = await registrationWithIdLength(0);
    expect(await accept(() => verifyRegistration(candidate, expectedRegistration))).toBe(false);
    expect(await accept(() => libraryRegistration(candidate))).toBe(false);
  });

  test("fmt・空 statement・rpIdHash・UP/UV/AT の登録条件を個別に照らす", async () => {
    const { credential, data, replace } = await registration();
    expect(() =>
      verifyRegistration(
        { ...credential, attestation_object: attestation(data, "packed") },
        expectedRegistration,
      ),
    ).toThrow();
    expect(() =>
      verifyRegistration(
        { ...credential, attestation_object: attestation(data, "none", new Map([["alg", -7]])) },
        expectedRegistration,
      ),
    ).toThrow();
    for (const offset of [0, 32]) {
      const changed = Uint8Array.from(data);
      changed[offset] ^= offset === 32 ? 0x40 : 0x01;
      expect(() => verifyRegistration(replace(changed), expectedRegistration)).toThrow();
    }
    for (const flag of [0x44, 0x41]) {
      const changed = Uint8Array.from(data);
      changed[32] = flag;
      expect(() => verifyRegistration(replace(changed), expectedRegistration)).toThrow();
    }
  });

  test("attestationObject の途中切れ、過剰な入れ子、不正 major type を拒否する", async () => {
    const { credential } = await registration();
    const object = base64UrlDecode(credential.attestation_object);
    for (const broken of [
      object.subarray(0, object.length - 1),
      Uint8Array.from([0x81, ...Array(16).fill(0x81), 0x00]),
      Uint8Array.from([0xc0, 0x00]),
    ]) {
      expect(() =>
        verifyRegistration(
          { ...credential, attestation_object: base64UrlEncode(broken) },
          expectedRegistration,
        ),
      ).toThrow();
    }
  });

  for (const algorithm of ["ES256", "RS256", "EdDSA"] as const) {
    test(`${algorithm} の COSE 鍵を WebCrypto が import でき、鍵の型・曲線・必須成分を検査する`, async () => {
      const { credential, data, replace } = await registration(algorithm);
      const publicKey = verifyRegistration(credential, expectedRegistration).publicKey;
      expect(await checkPublicKey(base64UrlDecode(publicKey))).toBeUndefined();
      const key = decodeCborWhole(base64UrlDecode(publicKey)) as Map<number, unknown>;
      for (const label of [1, -1, -2]) {
        const altered = new Map(key);
        altered.delete(label);
        const changed = Uint8Array.from([...data.subarray(0, 71), ...encode(altered)]);
        expect(
          await accept(() =>
            checkPublicKey(
              base64UrlDecode(verifyRegistration(replace(changed), expectedRegistration).publicKey),
            ),
          ),
        ).toBe(false);
      }
    });
  }
});

describe("認証の署名と独立検証器との比較", () => {
  for (const algorithm of ["ES256", "RS256", "EdDSA"] as const) {
    test(`${algorithm} の正例、署名 1 byte 改竄、連結順を逆にした署名を比較する`, async () => {
      const { authenticator, credential } = await registration(algorithm);
      const publicKey = verifyRegistration(credential, expectedRegistration).publicKey;
      const assertion = await authenticator.get({ challenge, origin });
      const signature = base64UrlDecode(assertion.signature);
      signature[signature.length - 1] ^= 1;
      const altered = { ...assertion, signature: base64UrlEncode(signature) };
      // 入力の改竄だけでは連結順の誤りを独立に検出できないため、逆順のバイト列そのものを秘密鍵で署名する。
      const reversed = await authenticator.get({ challenge, origin, reversedSignedBytes: true });
      for (const [name, candidate, accepted] of [
        ["正例", assertion, true],
        ["改竄", altered, false],
        ["逆順で署名", reversed, false],
      ] as const) {
        expect([
          name,
          await accept(() => verifyAssertion(candidate, { publicKey }, expectedAssertion)),
          await accept(() => libraryAssertion(candidate, publicKey, 0)),
        ]).toEqual([name, accepted, accepted]);
      }
    });
  }

  test("type・challenge・origin の表記、rpIdHash、UV、counter の受理表を両検証器で照らす", async () => {
    const { authenticator, credential } = await registration();
    const publicKey = verifyRegistration(credential, expectedRegistration).publicKey;
    const original = await authenticator.get({ challenge, origin });
    const cases: [string, AssertionCredential, number, boolean][] = [
      ["正例", original, 0, true],
      ["type の大文字小文字", clientData(original, { type: "Webauthn.get" }), 0, false],
      [
        "challenge の大文字小文字",
        clientData(original, { challenge: challenge.toUpperCase() }),
        0,
        false,
      ],
      ["origin の末尾 slash", clientData(original, { origin: `${origin}/` }), 0, false],
      ["origin の port", clientData(original, { origin: `${origin}:8443` }), 0, false],
      ["origin の大文字小文字", clientData(original, { origin: "https://UI.example" }), 0, false],
      ["counter の巻き戻し", original, 1, false],
    ];
    const wrongRp = base64UrlDecode(original.authenticator_data);
    wrongRp[0] ^= 1;
    cases.push([
      "rpIdHash 不一致",
      { ...original, authenticator_data: base64UrlEncode(wrongRp) },
      0,
      false,
    ]);
    const withoutUv = base64UrlDecode(original.authenticator_data);
    withoutUv[32] &= ~0x04;
    cases.push([
      "UV 欠落",
      { ...original, authenticator_data: base64UrlEncode(withoutUv) },
      0,
      false,
    ]);
    for (const [name, candidate, counter, accepted] of cases) {
      expect([
        name,
        await accept(() =>
          verifyAssertion(candidate, { publicKey, signCount: counter }, expectedAssertion),
        ),
        await accept(() => libraryAssertion(candidate, publicKey, counter)),
      ]).toEqual([name, accepted, accepted]);
    }
  });

  test("登録の正例と CBOR・rpIdHash・flags・challenge の異常形を両検証器で照らす", async () => {
    const { credential, data, replace } = await registration();
    const badRp = Uint8Array.from(data);
    badRp[0] ^= 1;
    const noUv = Uint8Array.from(data);
    noUv[32] &= ~0x04;
    const cases: [string, RegistrationCredential, boolean][] = [
      ["正例", credential, true],
      ["rpIdHash 不一致", replace(badRp), false],
      ["UV 欠落", replace(noUv), false],
      [
        "CBOR 途中切れ",
        {
          ...credential,
          attestation_object: base64UrlEncode(
            base64UrlDecode(credential.attestation_object).subarray(0, 16),
          ),
        },
        false,
      ],
      [
        "challenge 不一致",
        {
          ...credential,
          client_data_json: base64UrlEncode(
            new TextEncoder().encode(
              JSON.stringify({ type: "webauthn.create", challenge: "other", origin }),
            ),
          ),
        },
        false,
      ],
    ];
    for (const [name, candidate, accepted] of cases) {
      expect([
        name,
        await accept(() => verifyRegistration(candidate, expectedRegistration)),
        await accept(() => libraryRegistration(candidate)),
      ]).toEqual([name, accepted, accepted]);
    }
  });
});
