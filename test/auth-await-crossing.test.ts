import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthChallenge, EnrollClaims, InstanceId, UserId } from "@ccmsg/protocol";
import { AUTH_CHALLENGE_TTL_MS, REGISTER_TTL_MS } from "@ccmsg/protocol";
import { Auth, AuthRecords, userKey } from "../src/auth/index.ts";
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
const ENDPOINT = "https://ui.example/" as const;
const ORIGIN = "https://ui.example";

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
  const records = new AuthRecords({ dir, publish: () => {}, now });
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
  return url.slice(url.indexOf("#enroll=") + "#enroll=".length);
}

/** An enrolment URL as another instance would have issued it. Nothing here
 * checks the signature — only the issuer can, and the issuer is the peer. */
function issuedElsewhere(claims: EnrollClaims): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.${randomBytes(32).toString("base64url")}`;
}

function peerClaims(): EnrollClaims {
  return {
    iss: PEER,
    purpose: "create_user",
    instance: PEER,
    origin: ORIGIN,
    endpoint: ENDPOINT,
    expires_at: Date.now() + REGISTER_TTL_MS,
    jti: randomBytes(16).toString("base64url"),
    user: randomBytes(16).toString("base64url"),
  };
}

function peerChallenge(): AuthChallenge {
  return {
    challenge: randomBytes(32).toString("base64url"),
    issuer: PEER,
    expires_at: Date.now() + AUTH_CHALLENGE_TTL_MS,
  };
}

/** A person made here, at this instance, so an assertion has something to
 * answer for. */
async function registeredHere(it: Made, signCount = 0) {
  const issued = await it.auth.issue({ purpose: "create_user" });
  const user = issued.user as UserId;
  const authenticator = new SoftAuthenticator(issued.rp_id);
  authenticator.signCount = signCount;
  const challenge = (await it.auth.challenge()).challenge;
  const credential = await authenticator.create({ challenge, origin: ORIGIN, userId: user });
  await it.auth.register({ token: tokenOf(issued.url), code: issued.code, credential });
  return { issued, user, authenticator };
}

describe("an issuer's answer is read against the contract before anything turns on it", () => {
  /** An answer outside the op's result is a fault between the instances; one
   * inside it that says something other than the URL did is a refusal. Both
   * leave nothing behind. */
  const shapes: { name: string; code: string; answer: (claims: EnrollClaims) => unknown }[] = [
    { name: "no claims at all", code: "internal_error", answer: () => ({ kind: "claims" }) },
    {
      name: "a person's id that is not sixteen bytes",
      code: "internal_error",
      answer: (claims) => ({ kind: "claims", claims: { ...claims, user: "somebody" } }),
    },
    {
      name: "no origin",
      code: "internal_error",
      answer: (claims) => {
        const { origin: _origin, ...rest } = claims;
        return { kind: "claims", claims: rest };
      },
    },
    {
      name: "a purpose the URL did not state",
      code: "auth_invalid",
      answer: (claims) => {
        const { user: _user, ...rest } = claims;
        return { kind: "claims", claims: { ...rest, purpose: "add_owner" } };
      },
    },
  ];

  for (const shape of shapes) {
    test(`a registration answered with ${shape.name} is refused and leaves no record`, async () => {
      const it = made();
      const claims = peerClaims();
      const authenticator = new SoftAuthenticator(new URL(claims.origin).hostname);
      const challenge = (await it.auth.challenge()).challenge;
      const credential = await authenticator.create({
        challenge,
        origin: ORIGIN,
        userId: claims.user,
      });
      it.peer.answer = () => shape.answer(claims);

      expect(
        await refusal(
          it.auth.register({ token: issuedElsewhere(claims), code: "123456", credential }),
        ),
      ).toBe(shape.code);

      // Nothing was written down, nothing was spent, and what the carrier
      // reads from the records still reads.
      expect(it.peer.calls.map((call) => call.op)).toEqual(["auth.resolve"]);
      expect(it.records.users()).toEqual([]);
      expect(it.records.credentials()).toEqual([]);
      expect(it.records.families()).toEqual([]);
      expect(existsSync(it.file)).toBe(false);
      expect(it.auth.heldCounts.challenges).toBe(1);
      // Nobody was made and nobody owns this instance, so there is no page it
      // answers for: the set is what its owners' passkeys put in it, and
      // nothing else (contract, DR-0030 §9).
      expect(it.auth.knownOrigins()).toEqual([]);
    });
  }
});

describe("a write the records refused is not answered as a session", () => {
  test("a person removed while the issuer was being asked is not registered", async () => {
    const it = made();
    const issued = await it.auth.issue({ purpose: "create_user" });
    const user = issued.user as UserId;
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const stated = peerChallenge();
    const credential = await authenticator.create({
      challenge: stated.challenge,
      origin: ORIGIN,
      userId: user,
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
    // A peer's mark over the person, landing while the challenge is being
    // spent: the write that would have made them is refused by it.
    const at = Date.now() + 1_000;
    await it.records.merge([
      { key: userKey(user), updated_at: at, body: { kind: "tombstone", deleted_at: at } },
    ]);
    it.peer.release();

    expect(await refusal(pending)).toBe("forbidden");
    expect(it.records.users()).toEqual([]);
    expect(it.records.credentials()).toEqual([]);
    expect(it.records.families()).toEqual([]);
  });

  test("a credential removed while its assertion was being verified signs nobody in", async () => {
    const it = made();
    const { user, authenticator } = await registeredHere(it);
    const stated = peerChallenge();
    const credential = await authenticator.get({ challenge: stated.challenge, origin: ORIGIN });
    it.peer.answer = () => ({ kind: "challenge" });
    const reached = it.peer.hold();

    const pending = it.auth.assert({ challenge: stated, credential });
    await reached;
    await it.auth.removeCredential(user, authenticator.credentialIdUrl);
    it.peer.release();

    expect(await refusal(pending)).toBe("auth_invalid");
    expect(it.records.credentials()).toEqual([]);
    // The registration's family is the only one: the assertion minted none.
    expect(it.records.families()).toHaveLength(1);
  });
});

describe("two assertions of one credential in flight at once", () => {
  test("the one that started first and finished last does not put its count back", async () => {
    const it = made();
    const { user, authenticator } = await registeredHere(it, 5);
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
    const local = await it.auth.challenge();
    const second = await authenticator.get({ challenge: local.challenge, origin: ORIGIN });
    const later = await it.auth.assert({ challenge: local, credential: second });
    expect(later.session.user).toBe(user);
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
