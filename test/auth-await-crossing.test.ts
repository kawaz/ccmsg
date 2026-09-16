import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthChallenge, InstanceId, RegisterClaims, TokenFamily } from "@ccmsg/protocol";
import { AUTH_CHALLENGE_TTL_MS, REGISTER_TTL_MS } from "@ccmsg/protocol";
import { Auth, AuthRecords } from "../src/auth/index.ts";
import { OpError } from "../src/dispatch/index.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { trackRoot } from "./harness.ts";

/** What an exchange has to check again on the far side of an await (DR-0015
 * §2.5): that the issuer's answer is the shape the contract names, that the
 * records took what was written, and that the credential read before the
 * verification is still the one standing after it.
 *
 * Against `Auth` over its records rather than a running instance, because
 * every one of these is an interleaving — and the mesh is stood in for by an
 * `ask` the test holds open, which is the only way to land a removal or a
 * second assertion inside the window. */

const SELF: InstanceId = "0".repeat(32);
const PEER: InstanceId = "f".repeat(32);
const ENDPOINT = "http://ui.example/" as const;
const ORIGIN = "http://ui.example";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An `ask` the test answers by hand: what the peer says is set per call, and a
 * call can be held open until the test has done something else in between. */
class Peer {
  answer: (op: string, args: Record<string, unknown>) => unknown = () => ({});
  #release: (() => void) | undefined;
  #reached: (() => void) | undefined;
  #held: Promise<void> | undefined;
  readonly calls: { to: InstanceId; op: string; args: Record<string, unknown> }[] = [];

  /** The next call waits here until `release` is called; the promise answered
   * settles when the call has arrived. */
  hold(): Promise<void> {
    this.#held = new Promise((resolve) => {
      this.#release = resolve;
    });
    return new Promise((resolve) => {
      this.#reached = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#release = undefined;
  }

  async ask(to: InstanceId, op: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ to, op, args });
    this.#reached?.();
    this.#reached = undefined;
    if (this.#held !== undefined) {
      const held = this.#held;
      this.#held = undefined;
      await held;
    }
    return this.answer(op, args);
  }
}

interface Made {
  readonly auth: Auth;
  readonly records: AuthRecords;
  readonly peer: Peer;
  readonly file: string;
}

function made(options: { now?: () => number } = {}): Made {
  const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-await-"));
  roots.push(dir);
  trackRoot(dir);
  const now = options.now ?? Date.now;
  const peer = new Peer();
  const records = new AuthRecords({ dir, self: SELF, publish: () => {}, now });
  const auth = new Auth({
    self: SELF,
    records,
    endpoint: () => ENDPOINT,
    unit: "unit",
    ask: (to, op, args) => peer.ask(to, op, args),
    now,
  });
  return { auth, records, peer, file: join(dir, "records.json") };
}

/** The code an op refused with, or nothing where it answered. Stated rather
 * than only that something was thrown, because a session answered where a
 * refusal was due is exactly what these are about. */
async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
    return undefined;
  } catch (cause) {
    if (cause instanceof OpError) return cause.code;
    throw cause;
  }
}

function tokenOf(url: string): string {
  return url.slice(url.indexOf("#register=") + "#register=".length);
}

/** A registration URL as another instance would have issued it. Nothing here
 * checks the signature — only the issuer can, and the issuer is the peer. */
function issuedElsewhere(claims: RegisterClaims): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.${randomBytes(32).toString("base64url")}`;
}

function peerClaims(): RegisterClaims {
  return {
    iss: PEER,
    sub: "unit-1",
    unit: "unit",
    endpoint: ENDPOINT,
    webui: ENDPOINT,
    expires_at: Date.now() + REGISTER_TTL_MS,
    jti: randomBytes(16).toString("base64url"),
    user_id: randomBytes(16).toString("base64url"),
  };
}

function peerChallenge(): AuthChallenge {
  return {
    challenge: randomBytes(32).toString("base64url"),
    issuer: PEER,
    expires_at: Date.now() + AUTH_CHALLENGE_TTL_MS,
  };
}

/** A credential registered here, at this instance, so an assertion has
 * something to answer for. */
async function registeredHere(it: Made, signCount = 0) {
  const issued = it.auth.issue({ endpoint: ENDPOINT });
  const authenticator = new SoftAuthenticator(issued.rp_id);
  authenticator.signCount = signCount;
  const challenge = it.auth.challenge().challenge;
  const credential = await authenticator.create({
    challenge,
    origin: ORIGIN,
    userId: issued.user_id,
  });
  await it.auth.register({ token: tokenOf(issued.url), code: issued.code, credential });
  return { issued, authenticator };
}

describe("an issuer's answer is read against the contract before anything turns on it", () => {
  const shapes: { name: string; answer: (claims: RegisterClaims) => unknown }[] = [
    { name: "no claims at all", answer: () => ({ kind: "register" }) },
    {
      name: "a subject that is not a string",
      answer: (claims) => ({ kind: "register", claims: { ...claims, sub: 42 } }),
    },
    {
      name: "no endpoint",
      answer: (claims) => {
        const { endpoint: _endpoint, ...rest } = claims;
        return { kind: "register", claims: rest };
      },
    },
  ];

  for (const shape of shapes) {
    test(`a registration answered with ${shape.name} is refused and leaves no record`, async () => {
      const it = made();
      const claims = peerClaims();
      const authenticator = new SoftAuthenticator(new URL(claims.webui).hostname);
      const challenge = it.auth.challenge().challenge;
      const credential = await authenticator.create({
        challenge,
        origin: ORIGIN,
        userId: claims.user_id,
      });
      it.peer.answer = () => shape.answer(claims);

      expect(
        await refusal(
          it.auth.register({ token: issuedElsewhere(claims), code: "123456", credential }),
        ),
      ).toBe("internal_error");

      // Nothing was written down, nothing was spent, and what the carrier
      // reads from the records still reads.
      expect(it.peer.calls.map((call) => call.op)).toEqual(["auth.resolve"]);
      expect(it.records.credentials()).toEqual([]);
      expect(it.records.families()).toEqual([]);
      expect(existsSync(it.file)).toBe(false);
      expect(it.auth.held.challenges).toBe(1);
      // Nothing was registered and this instance issued no URL of its own, so
      // there is no page it answers for: the set is what registrations and its
      // own outstanding URLs put in it, and nothing else (contract, DR-0029).
      expect(it.auth.knownOrigins()).toEqual([]);
    });
  }

  test("a rotation answered without the refresh token is refused rather than passed on", async () => {
    const it = made();
    const now = Date.now();
    const family: TokenFamily = {
      kind: "token_family",
      sub: "them",
      iss: PEER,
      webui: ENDPOINT,
      access: { value: randomBytes(32).toString("base64url"), expires_at: now + 3_600_000 },
      refresh: { value: randomBytes(32).toString("base64url"), expires_at: now + 86_400_000 },
    };
    await it.records.merge([{ key: "family/them/1", updated_at: now, body: family }]);
    it.peer.answer = () => ({ sub: "them", access: family.access });

    expect(await refusal(it.auth.refreshToken(family.refresh.value))).toBe("internal_error");
    expect(it.peer.calls.map((call) => call.op)).toEqual(["auth.rotate"]);
  });
});

describe("a write the records refused is not answered as a session", () => {
  test("a person removed while the issuer was being asked is not registered", async () => {
    const it = made();
    const issued = it.auth.issue({ endpoint: ENDPOINT });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const stated = peerChallenge();
    const credential = await authenticator.create({
      challenge: stated.challenge,
      origin: ORIGIN,
      userId: issued.user_id,
    });
    it.peer.answer = () => ({ kind: "challenge" });
    const reached = it.peer.hold();

    const pending = it.auth.register({
      token: tokenOf(issued.url),
      code: issued.code,
      challenge: stated,
      credential,
    });
    await reached;
    await it.auth.remove(issued.sub);
    it.peer.release();

    expect(await refusal(pending)).toBe("forbidden");
    expect(it.records.credentials()).toEqual([]);
    expect(it.records.families()).toEqual([]);
  });

  test("a family the records refused mints nothing", async () => {
    const it = made();
    await it.records.remove("gone");
    expect(await refusal(it.auth.mint("gone", ENDPOINT))).toBe("forbidden");
    expect(it.records.families()).toEqual([]);
  });

  test("a credential removed while its assertion was being verified signs nobody in", async () => {
    const it = made();
    const { issued, authenticator } = await registeredHere(it);
    const stated = peerChallenge();
    const credential = await authenticator.get({ challenge: stated.challenge, origin: ORIGIN });
    it.peer.answer = () => ({ kind: "challenge" });
    const reached = it.peer.hold();

    const pending = it.auth.assert({ challenge: stated, credential });
    await reached;
    await it.auth.remove(issued.sub);
    it.peer.release();

    expect(await refusal(pending)).toBe("auth_invalid");
    expect(it.records.credentials()).toEqual([]);
    expect(it.records.families()).toEqual([]);
  });
});

describe("two assertions of one credential in flight at once", () => {
  test("the one that started first and finished last does not put its count back", async () => {
    const it = made();
    const { authenticator } = await registeredHere(it, 5);
    const id = authenticator.credentialIdUrl;
    expect(it.records.credential(id)?.sign_count).toBe(5);
    expect(it.records.families()).toHaveLength(1);

    // The first assertion reads the record at 5, verifies a 6, and then waits
    // on its challenge's issuer.
    authenticator.signCount = 6;
    const stated = peerChallenge();
    const first = await authenticator.get({ challenge: stated.challenge, origin: ORIGIN });
    it.peer.answer = () => ({ kind: "challenge" });
    const reached = it.peer.hold();
    const earlier = it.auth.assert({ challenge: stated, credential: first });
    await reached;

    // The second reads the same 5, verifies a 7, and finishes: the record
    // says 7.
    authenticator.signCount = 7;
    const local = it.auth.challenge();
    const second = await authenticator.get({ challenge: local.challenge, origin: ORIGIN });
    const later = await it.auth.assert({ challenge: local, credential: second });
    expect(later.session.sub).toBe(it.records.credential(id)?.sub as string);
    expect(it.records.credential(id)?.sign_count).toBe(7);

    // The first comes back to a record that has moved past it. Its 6 is now
    // the reading a copy would make, and it is refused as one.
    it.peer.release();
    expect(await refusal(earlier)).toBe("auth_invalid");
    expect(it.records.credential(id)?.sign_count).toBe(7);
    // The registration's family and the second assertion's; the first minted none.
    expect(it.records.families()).toHaveLength(2);
  });
});
