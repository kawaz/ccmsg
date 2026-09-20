import { describe, expect, test } from "bun:test";
import {
  checkAuthenticator,
  checkClientData,
  parseAuthenticatorData,
  sha256,
  WebAuthnError,
} from "../src/auth/index.ts";

const ORIGIN = "https://ui.example";
const RP_ID = "ui.example";
const CHALLENGE = "Q0hBTExFTkdF";

function clientData(fields: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fields));
}

/** What a check refused, or `undefined` when it let the value through. */
function refusal(check: () => void): string | undefined {
  try {
    check();
    return undefined;
  } catch (cause) {
    if (!(cause instanceof WebAuthnError)) throw cause;
    return cause.message;
  }
}

function checked(fields: Record<string, unknown>): string | undefined {
  return refusal(() =>
    checkClientData(clientData(fields), {
      type: "webauthn.get",
      challenge: CHALLENGE,
      origin: ORIGIN,
    }),
  );
}

/** The 37 bytes every assertion carries: the relying party, the flags and the
 * counter. */
function authData(options: { rpId?: string; flags?: number; signCount?: number } = {}): Uint8Array {
  const bytes = new Uint8Array(37);
  bytes.set(sha256(options.rpId ?? RP_ID), 0);
  // User present and user verified, which is what an exchange this instance
  // asked for comes back with.
  bytes[32] = options.flags ?? 0x05;
  new DataView(bytes.buffer).setUint32(33, options.signCount ?? 0);
  return bytes;
}

describe("what the page said it was doing (WebAuthn L2 §7.2)", () => {
  test("the exchange this instance asked for is let through", () => {
    expect(checked({ type: "webauthn.get", challenge: CHALLENGE, origin: ORIGIN })).toBeUndefined();
    // Chromium writes the field on every message; reading its presence as a
    // refusal would turn away every credential those browsers make.
    expect(
      checked({ type: "webauthn.get", challenge: CHALLENGE, origin: ORIGIN, crossOrigin: false }),
    ).toBeUndefined();
  });

  test("the origin is the one the credential names, spelled exactly", () => {
    // An origin is compared as the serialization it is: a different port, a
    // different scheme, a different case and a trailing slash are each another
    // origin, and none of them is the one the credential was made at.
    for (const origin of [
      "https://ui.example:8443",
      "http://ui.example",
      "https://UI.example",
      "https://ui.example/",
      "https://ui.example.evil",
      "https://evil.ui.example",
    ]) {
      expect([origin, checked({ type: "webauthn.get", challenge: CHALLENGE, origin })]).toEqual([
        origin,
        `${origin} is not ${ORIGIN}`,
      ]);
    }
  });

  test("the challenge is the one this instance issued, and the type the ceremony it is", () => {
    expect(
      checked({ type: "webauthn.get", challenge: "c29tZXRoaW5nIGVsc2U", origin: ORIGIN }),
    ).toBe("the client data answers another challenge");
    // A registration's message replayed into an assertion: the right challenge
    // for the wrong ceremony.
    expect(checked({ type: "webauthn.create", challenge: CHALLENGE, origin: ORIGIN })).toBe(
      "the client data is for webauthn.create",
    );
  });

  test("an exchange an embedding page ran is refused", () => {
    expect(
      checked({ type: "webauthn.get", challenge: CHALLENGE, origin: ORIGIN, crossOrigin: true }),
    ).toBe("this exchange must not be run from an embedded page");
    // `topOrigin` is only ever written when the exchange was cross-origin, so
    // its presence at all is the refusal.
    expect(
      checked({
        type: "webauthn.get",
        challenge: CHALLENGE,
        origin: ORIGIN,
        topOrigin: "https://elsewhere.example",
      }),
    ).toBe("this exchange must not be run from an embedded page");
  });

  test("a field of the wrong type, and data that is not JSON at all, are refused", () => {
    expect(checked({ type: "webauthn.get", challenge: 1, origin: ORIGIN })).toBe(
      "the client data answers another challenge",
    );
    expect(checked({ type: "webauthn.get", challenge: CHALLENGE, origin: 1 })).toBe(
      `1 is not ${ORIGIN}`,
    );
    expect(
      refusal(() =>
        checkClientData(new Uint8Array([0x7b]), {
          type: "webauthn.get",
          challenge: CHALLENGE,
          origin: ORIGIN,
        }),
      ),
    ).toStartWith("the client data is not JSON");
  });
});

describe("what the authenticator said (WebAuthn L2 §7.2)", () => {
  test("a relying party this instance serves is let through, and another is not", () => {
    expect(refusal(() => checkAuthenticator(parseAuthenticatorData(authData()), [RP_ID]))).toBe(
      undefined,
    );
    // Several may be named, because a credential does not say which one it was
    // made for; each is one the operator configured.
    expect(
      refusal(() =>
        checkAuthenticator(parseAuthenticatorData(authData()), ["other.example", RP_ID]),
      ),
    ).toBeUndefined();
    // A name whose hash is not the one signed — including the one that only
    // looks like it.
    for (const rpId of ["ui.example.evil", "example", "UI.example"]) {
      expect([
        rpId,
        refusal(() => checkAuthenticator(parseAuthenticatorData(authData()), [rpId])),
      ]).toEqual([rpId, "the authenticator answered for another relying party"]);
    }
  });

  test("a person has to have been present and verified", () => {
    // UV without UP, UP without UV, and neither.
    expect(
      refusal(() => checkAuthenticator(parseAuthenticatorData(authData({ flags: 0x04 })), [RP_ID])),
    ).toBe("no person was present");
    expect(
      refusal(() => checkAuthenticator(parseAuthenticatorData(authData({ flags: 0x01 })), [RP_ID])),
    ).toBe("no person was verified");
    expect(
      refusal(() => checkAuthenticator(parseAuthenticatorData(authData({ flags: 0x00 })), [RP_ID])),
    ).toBe("no person was present");
  });

  test("the counter is read as the authenticator wrote it", () => {
    // Big-endian, and the whole 32 bits: a counter past 2^31 must not come
    // back negative.
    expect(parseAuthenticatorData(authData({ signCount: 1 })).signCount).toBe(1);
    expect(parseAuthenticatorData(authData({ signCount: 0xff_ff_ff_ff })).signCount).toBe(
      4_294_967_295,
    );
  });

  test("authenticator data shorter than its fixed head is refused", () => {
    expect(refusal(() => parseAuthenticatorData(authData().subarray(0, 36)))).toBe(
      "the authenticator data is too short",
    );
  });
});
