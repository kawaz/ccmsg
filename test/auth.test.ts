import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CredentialRecord, PROTOCOL_VERSION } from "@ccmsg/protocol";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import {
  Auth,
  AuthRecords,
  handleAdmin,
  handleAuth,
  cookieName,
  cookiePath,
  originOf,
  PREVIOUS_GRACE_MS,
  ACCESS_KEEP_MS,
  ACCESS_TTL_MS,
  servesPath,
} from "../src/auth/index.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { connectWs, type LineClient } from "./client.ts";

/** The person's authentication end to end (DR-0001): a registration URL made
 * on the machine, a credential registered against it, an assertion, the tokens
 * that follow, and what a removal does to all of it.
 *
 * Against a running instance rather than against the pieces, because the parts
 * that can be wrong are the joins: which route a browser reaches, what a cookie
 * carries, and what a WebSocket handshake presents. */

const running: Instance[] = [];
const clients: LineClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
});

/** An instance on a port chosen here rather than by the kernel.
 *
 * The page's origin has to be in the config before the listener is bound, and a
 * passkey is made for a host — so the address is settled first and the origin,
 * the endpoint and the relying party all follow from it, which is the ordinary
 * configuration (§2.3). */
let nextPort = 45_000 + Math.floor(Math.random() * 10_000);

async function serving(
  options: { now?: () => number } = {},
): Promise<{ instance: Instance; origin: string }> {
  const port = (nextPort += 1);
  const origin = `http://127.0.0.1:${String(port)}`;
  const root = mkdtempSync(join(tmpdir(), "ccmsg-auth-"));
  mkdirSync(join(root, "home", "sessions"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "config.json"),
    JSON.stringify({
      defaults: { entry: { host: "127.0.0.1", port } },
    }),
  );
  const env: Env = {
    CLAUDE_CONFIG_DIR: join(root, "home"),
    CCMSG_STATE_DIR: join(root, "state"),
    CCMSG_CONFIG_DIR: join(root, "config"),
  };
  const outcome = await start({
    env,
    echoLog: false,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  return { instance: outcome, origin };
}

/** One `/auth/*` request, as the page would make it. */
async function post(
  at: { instance: Instance; origin: string },
  route: string,
  body: unknown,
  init: { cookie?: string } = {},
): Promise<Response> {
  return await fetch(`http://${at.instance.http[0] as string}/auth/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: at.origin,
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    body: JSON.stringify(body ?? {}),
  });
}

/** This instance's endpoint: the base URL it is served at, which a
 * registration has to be told. An instance with no mesh has settled none of its
 * own (§7.1), so the URL is the caller's to state. */
function servedAt(at: { instance: Instance }): `http://${string}/` {
  return `http://${at.instance.http[0] as string}/`;
}

/** The whole of what a person does the first time: take the URL and the code
 * off the terminal, make a credential, and be signed in. */
async function registered(
  at: { instance: Instance; origin: string },
  options: { backup?: { eligible: boolean; state: boolean } } = {},
) {
  const issued = at.instance.auth.issue({ endpoint: servedAt(at) });
  const authenticator = new SoftAuthenticator(issued.rp_id);
  if (options.backup !== undefined) {
    authenticator.backupEligible = options.backup.eligible;
    authenticator.backupState = options.backup.state;
  }
  const challenge = (await (await post(at, "challenge", {})).json()) as {
    challenge: string;
  };
  const credential = await authenticator.create({
    challenge: challenge.challenge,
    origin: at.origin,
    userId: issued.user_id,
  });
  const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
  const response = await post(at, "register", {
    token,
    code: issued.code,
    device_label: "the laptop",
    credential,
  });
  return { issued, authenticator, response };
}

describe("registering a passkey (§2.2)", () => {
  test("the URL and the code are two halves, and only both together register", async () => {
    const at = await serving();
    const issued = at.instance.auth.issue({ endpoint: servedAt(at) });
    // The code is not in the URL: a leaked URL is not a registration.
    expect(issued.url).not.toContain(issued.code);
    expect(issued.url).toContain("#register=");

    const authenticator = new SoftAuthenticator(issued.rp_id);
    const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
    const wrong = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const refused = await post(at, "register", {
      token,
      code: issued.code === "000000" ? "111111" : "000000",
      credential: await authenticator.create({ challenge: wrong.challenge, origin: at.origin }),
    });
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("auth_invalid");
  });

  test("a registration signs the person in and leaves a record to read back", async () => {
    const at = await serving();
    const { response, issued } = await registered(at);
    expect(response.status).toBe(200);
    const session = (await response.json()) as { sub: string; access: { value: string } };
    expect(session.sub).toBe(issued.sub);
    expect(session.access.value.length).toBeGreaterThan(20);
    // The refresh token is a cookie and is in no body a page can read.
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(cookieName(at.instance.self, issued.sub));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Path=${cookiePath("/auth/register")}`);
    expect(JSON.stringify(session)).not.toContain(cookie.split(";")[0]?.split("=")[1] ?? "!");

    const [record] = at.instance.auth.list();
    expect(record?.sub).toBe(issued.sub);
    expect(record?.device_label).toBe("the laptop");
    expect(record?.registered_user_agent === undefined).toBe(false);
  });

  test("what the authenticator said about backing the credential up is on the line the person reads", async () => {
    const at = await serving();
    // Two keys, which is the whole point of keeping the flags: one that syncs
    // across the person's devices, and one that exists only on the stick it was
    // made on. Removing the second costs them the key; removing the first does
    // not, and nothing else on the line says which is which.
    await registered(at, { backup: { eligible: true, state: true } });
    await registered(at, { backup: { eligible: false, state: false } });
    const answer = handleAdmin(at.instance.auth, {
      admin: "passkey_list",
      request_id: "asking",
    });
    expect(answer.kind).toBe("reply");
    const listed = (answer as unknown as { response: { credentials: CredentialRecord[] } }).response
      .credentials;
    // By what each line says rather than by their order: two registrations a
    // moment apart are sorted by a timestamp they may well share.
    expect(listed.length).toBe(2);
    expect(listed.filter((record) => record.backup_eligible && record.backup_state).length).toBe(1);
    expect(
      listed.filter((record) => record.backup_eligible === false && record.backup_state === false)
        .length,
    ).toBe(1);
  });

  test("the registration URL is spent, so the same one cannot register twice", async () => {
    const at = await serving();
    const { issued, authenticator } = await registered(at);
    const again = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
    const refused = await post(at, "register", {
      token,
      code: issued.code,
      credential: await authenticator.create({ challenge: again.challenge, origin: at.origin }),
    });
    expect(refused.status).toBe(401);
  });
});

/** The refresh token a response set, as the browser would send it back. */
function mintedCookie(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.split(";")[0]?.split("=").slice(1).join("=") ?? "";
  return `${name}=${value}`;
}

describe("authenticating and the tokens that follow (§2.4, §2.5)", () => {
  test("an assertion mints a session, and the WebSocket takes its token", async () => {
    const at = await serving();
    const { issued, authenticator } = await registered(at);

    const challenge = (await (await post(at, "challenge", {})).json()) as {
      challenge: string;
      issuer: string;
      expires_at: number;
    };
    expect(challenge.issuer).toBe(at.instance.self);
    const asserted = await post(at, "assert", {
      credential: await authenticator.get({ challenge: challenge.challenge, origin: at.origin }),
      challenge,
    });
    expect(asserted.status).toBe(200);
    const session = (await asserted.json()) as { sub: string; access: { value: string } };
    expect(session.sub).toBe(issued.sub);

    const client = await connectWs(at.instance.http[0] ?? "", session.access.value);
    clients.push(client);
    client.send({ op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION });
    const greeting = (await client.next()) as { ok: boolean; auth_expires_at?: number };
    expect(greeting.ok).toBe(true);
    expect(typeof greeting.auth_expires_at).toBe("number");
  });

  test("a challenge is good once", async () => {
    const at = await serving();
    const { authenticator } = await registered(at);
    const challenge = (await (await post(at, "challenge", {})).json()) as {
      challenge: string;
      issuer: string;
      expires_at: number;
    };
    const credential = await authenticator.get({
      challenge: challenge.challenge,
      origin: at.origin,
    });
    expect((await post(at, "assert", { credential, challenge })).status).toBe(200);
    expect((await post(at, "assert", { credential, challenge })).status).toBe(401);
  });

  test("refreshing rotates, and any generation rotated away fails the family", async () => {
    const at = await serving();
    // The registration URL is what tells this instance which relying party its
    // pages belong to, and every `/auth/*` answer is bounded by that (§2.3).
    at.instance.auth.issue({ endpoint: servedAt(at) });
    const first = at.instance.auth.mint("someone");
    const name = cookieName(at.instance.self, "someone");
    const zero = `${name}=${first.refresh.value}`;

    const one = await post(at, "refresh", {}, { cookie: zero });
    expect(one.status).toBe(200);
    const next = (await one.json()) as { access: { value: string } };
    // The cookie turned over; the access token is the family's one token and is
    // answered as it stands, because the person's other pages are holding it.
    expect(next.access.value).toBe(first.session.access.value);
    const first_rotation = mintedCookie(one, name);
    expect(first_rotation).not.toBe(zero);

    // The generation before the standing one is answered rather than refused: a
    // reply lost on the way is a retry, not a replay, and it is answered with
    // the pair the caller missed rather than by rotating again.
    expect((await post(at, "refresh", {}, { cookie: zero })).status).toBe(200);

    const two = await post(at, "refresh", {}, { cookie: first_rotation });
    expect(two.status).toBe(200);
    const standing = mintedCookie(two, name);

    // Two generations back is past every grace, and the issuer remembers what
    // it rotated away — so this is a token being reused, and the family goes
    // with it, standing token included.
    expect((await post(at, "refresh", {}, { cookie: zero })).status).toBe(401);
    expect((await post(at, "refresh", {}, { cookie: standing })).status).toBe(401);
  });

  test("a refresh states why it was asked for, and the family keeps the last one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-why-"));
    const self = "0".repeat(32);
    const records = new AuthRecords({ dir, self, publish: () => {} });
    const auth = new Auth({
      self,
      records,
      endpoint: () => "https://ui.example.com/",
      unit: "unit",
    });
    auth.issue({});
    const minted = auth.mint("someone");
    const name = cookieName(self, "someone");

    const refresh = async (value: string, body: unknown) =>
      await handleAuth(
        new Request("https://ui.example.com/auth/refresh", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://ui.example.com",
            "user-agent": "a browser",
            cookie: `${name}=${value}`,
          },
          body: JSON.stringify(body),
        }),
        { auth, self },
        { ip: "203.0.113.7" },
      );

    const one = await refresh(minted.refresh.value, { reason: "reload" });
    expect(one?.status).toBe(200);
    const first = mintedCookie(one as Response, name).slice(name.length + 1);
    const [held] = records.families();
    expect(held?.body.last_refresh?.reason).toBe("reload");
    expect(held?.body.last_refresh?.ip).toBe("203.0.113.7");
    expect(held?.body.last_refresh?.user_agent).toBe("a browser");
    expect(typeof held?.body.last_refresh?.at).toBe("number");

    // Only the rotation that stands is kept, so the next one takes its place.
    const two = await refresh(first, { reason: "reconnect" });
    expect(two?.status).toBe(200);
    expect(records.families()[0]?.body.last_refresh?.reason).toBe("reconnect");

    // A caller that says nothing is as good a refresh as any, and leaves the
    // family saying only that it rotated.
    const second = mintedCookie(two as Response, name).slice(name.length + 1);
    expect((await refresh(second, {}))?.status).toBe(200);
    const last = records.families()[0]?.body.last_refresh;
    expect(last?.reason).toBeUndefined();
    expect(last?.ip).toBe("203.0.113.7");
  });

  test("an origin that is none of this instance's endpoints is refused before anything else", async () => {
    const at = await serving();
    // A registration URL exists, so this instance does hold a relying party —
    // the refusal below is about the origin asking and not about there being
    // nothing to compare it with.
    at.instance.auth.issue({ endpoint: servedAt(at) });
    const refused = await fetch(`http://${at.instance.http[0] as string}/auth/challenge`, {
      method: "POST",
      headers: { origin: "http://elsewhere.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(403);
  });

  test("a sibling of this instance's own host is not this instance", async () => {
    // The relying party is a domain, so every host under it is one an
    // authenticator will answer for. That is not who may read these answers:
    // `/auth/refresh` hands back an access token, and a browser attaches the
    // cookie for it by domain, so a neighbour let in on the domain alone would
    // read the person's token. The comparison is of whole origins.
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-cors-"));
    const self = "0".repeat(32);
    const auth = new Auth({
      self,
      records: new AuthRecords({ dir, self, publish: () => {} }),
      endpoint: () => "https://ui.example.com/",
      unit: "unit",
    });
    auth.issue({});
    expect(auth.knownOrigins()).toEqual(["https://ui.example.com"]);
    const deps = { auth, self };
    const preflight = async (origin: string) =>
      (
        await handleAuth(
          new Request("https://ui.example.com/auth/refresh", {
            method: "OPTIONS",
            headers: { origin },
          }),
          deps,
        )
      )?.status;
    expect(await preflight("https://evil.example.com")).toBe(403);
    expect(await preflight("https://example.com")).toBe(403);
    // A different port is a different origin, and so is a different scheme.
    expect(await preflight("https://ui.example.com:8443")).toBe(403);
    expect(await preflight("http://ui.example.com")).toBe(403);
    expect(await preflight("https://ui.example.com")).toBe(204);
  });

  test("a preflight from a page at this instance's own endpoint is answered with credentials allowed", async () => {
    const at = await serving();
    // What makes this instance answer for that page is the registration URL an
    // operator issued for it: no list of origins is configured, and the
    // endpoint the URL names is where the answer comes from (DR-0001 §2.3).
    at.instance.auth.issue({ endpoint: servedAt(at) });
    const answer = await fetch(`http://${at.instance.http[0] as string}/auth/assert`, {
      method: "OPTIONS",
      headers: { origin: at.origin },
    });
    expect(answer.status).toBe(204);
    expect(answer.headers.get("access-control-allow-origin")).toBe(at.origin);
    expect(answer.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("removing a person (§2.6)", () => {
  test("the credential goes, the connection is closed, and it cannot come back", async () => {
    const at = await serving();
    const { issued, authenticator } = await registered(at);
    const challenge = (await (await post(at, "challenge", {})).json()) as {
      challenge: string;
      issuer: string;
      expires_at: number;
    };
    const session = (await (
      await post(at, "assert", {
        credential: await authenticator.get({ challenge: challenge.challenge, origin: at.origin }),
        challenge,
      })
    ).json()) as { access: { value: string } };
    const client = await connectWs(at.instance.http[0] ?? "", session.access.value);
    client.send({ op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION });
    await client.next();

    const gone = Promise.withResolvers<void>();
    const closed = at.instance.auth.remove(issued.sub);
    expect(closed.closed).toBeGreaterThan(0);
    expect(at.instance.auth.list()).toEqual([]);
    // The token is no longer admitted, which is what the closed connection
    // cannot be reopened on.
    expect(at.instance.auth.admits(session.access.value)).toBeUndefined();
    setTimeout(() => gone.resolve(), 0);
    await gone.promise;

    // A record arriving from a partitioned peer does not bring it back: the
    // tombstone refuses every later write under that subject.
    const record = at.instance.auth.records.credentials();
    expect(record).toEqual([]);
  });
});

describe("the access token is the family's, shared by the person's pages (§2.4)", () => {
  test("rotation keeps the standing access token until it is half spent", () => {
    // A clock rather than a wait: what decides this is hours of TTL.
    let now = 1_000_000;
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-share-"));
    const self = "0".repeat(32);
    const auth = new Auth({
      self,
      records: new AuthRecords({ dir, self, publish: () => {}, now: () => now }),
      endpoint: () => undefined,
      unit: "unit",
      now: () => now,
    });
    const minted = auth.mint("someone");

    // Two loads in a row, as two tabs would do: the refresh cookie turns over
    // each time, the token the open pages hold does not.
    now += PREVIOUS_GRACE_MS + 1;
    const one = auth.rotate(minted.refresh.value);
    now += PREVIOUS_GRACE_MS + 1;
    const two = auth.rotate(one.refresh.value);
    expect(one.access.value).toBe(minted.session.access.value);
    expect(two.access.value).toBe(minted.session.access.value);
    expect(two.refresh.value).not.toBe(one.refresh.value);
    expect(auth.admits(minted.session.access.value)?.sub).toBe("someone");

    // Past the threshold the family mints, and the pages renew together.
    now += ACCESS_TTL_MS - ACCESS_KEEP_MS;
    const three = auth.rotate(two.refresh.value);
    expect(three.access.value).not.toBe(minted.session.access.value);
    expect(three.access.expires_at).toBe(now + ACCESS_TTL_MS);
    expect(auth.admits(minted.session.access.value)).toBeUndefined();
  });
});

describe("a token reused after its grace fails the family (§2.4)", () => {
  test("what the family remembers outlives the instance that rotated it", () => {
    // The digests travel with the family, so an instance that restarts — or a
    // peer the reused value is presented to — still recognises it (M4).
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-retired-"));
    const self = "0".repeat(32);
    const deps = {
      self,
      endpoint: () => undefined,
      unit: "unit",
    };
    const before = new Auth({
      ...deps,
      records: new AuthRecords({ dir, self, publish: () => {} }),
    });
    const zero = before.mint("someone").refresh.value;
    const one = before.rotate(zero);
    const two = before.rotate(one.refresh.value);
    const [family] = new AuthRecords({ dir, self, publish: () => {} }).families();
    expect((family?.body.retired ?? []).length).toBe(2);

    // A fresh domain over the same records: nothing of the rotation is left in
    // memory, and the value from two generations back is still recognised.
    const after = new Auth({ ...deps, records: new AuthRecords({ dir, self, publish: () => {} }) });
    expect(() => after.rotate(zero)).toThrow();
    expect(after.admits(two.access.value)).toBeUndefined();
  });

  test("the generation the family still remembers is what reuse is caught by", () => {
    // Against the domain rather than a listener, because what decides this is a
    // clock: the grace on the previous generation is a minute, and a test that
    // waited it out would be a test about waiting.
    let now = 1_000_000;
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-unit-"));
    const auth = new Auth({
      self: "0".repeat(32),
      records: new AuthRecords({ dir, self: "0".repeat(32), publish: () => {}, now: () => now }),
      endpoint: () => undefined,
      unit: "unit",
      now: () => now,
    });
    const zero = auth.mint("someone").refresh.value;
    const one = auth.rotate(zero);

    // Inside the grace it is the retry it looks like, answered with the pair
    // the caller missed.
    expect(auth.rotate(zero).refresh.value).toBe(one.refresh.value);

    now += PREVIOUS_GRACE_MS + 1;
    expect(() => auth.rotate(zero)).toThrow();
    // The family went with it, so the value that was standing is gone too.
    expect(auth.admits(one.access.value)).toBeUndefined();
  });
});

describe("what a registration or an assertion is refused for", () => {
  /** Every one of these answers `auth_invalid`, and none of them reaches a
   * fault: what arrives on these routes is attacker-supplied, so a message that
   * does not verify is a refusal in the contract's own vocabulary (M6). */
  async function refusedAssert(
    at: { instance: Instance; origin: string },
    make: (challenge: {
      challenge: string;
      issuer: string;
      expires_at: number;
    }) => Promise<unknown>,
  ): Promise<{ status: number; code: string }> {
    const challenge = (await (await post(at, "challenge", {})).json()) as {
      challenge: string;
      issuer: string;
      expires_at: number;
    };
    const response = await post(at, "assert", {
      credential: await make(challenge),
      challenge,
    });
    const body = (await response.json()) as { error?: { code?: string } };
    return { status: response.status, code: body.error?.code ?? "" };
  }

  test("a tampered client data is not the one that was signed", async () => {
    const at = await serving();
    const { authenticator } = await registered(at);
    const refused = await refusedAssert(at, async (challenge) => {
      const credential = await authenticator.get({
        challenge: challenge.challenge,
        origin: at.origin,
      });
      // The same fields, written again — so the signature is over the bytes the
      // authenticator produced and not over these.
      const client = JSON.parse(
        Buffer.from(credential.client_data_json, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      return {
        ...credential,
        client_data_json: Buffer.from(JSON.stringify({ ...client, extra: 1 })).toString(
          "base64url",
        ),
      };
    });
    expect(refused).toEqual({ status: 401, code: "auth_invalid" });
  });

  test("a page from another origin is not one this instance serves", async () => {
    const at = await serving();
    const { authenticator } = await registered(at);
    const refused = await refusedAssert(at, (challenge) =>
      authenticator.get({ challenge: challenge.challenge, origin: "http://elsewhere.example" }),
    );
    expect(refused).toEqual({ status: 401, code: "auth_invalid" });
  });

  test("an authenticator that verified nobody is turned away", async () => {
    const at = await serving();
    const { authenticator } = await registered(at);
    authenticator.userVerified = false;
    const refused = await refusedAssert(at, (challenge) =>
      authenticator.get({ challenge: challenge.challenge, origin: at.origin }),
    );
    expect(refused).toEqual({ status: 401, code: "auth_invalid" });
  });

  test("a counter that does not advance is a copy of the credential", async () => {
    const at = await serving();
    const { authenticator } = await registered(at);
    // A counter that was counting: the record takes the first non-zero reading.
    authenticator.signCount = 5;
    const ok = await refusedAssert(at, (challenge) =>
      authenticator.get({ challenge: challenge.challenge, origin: at.origin }),
    );
    expect(ok.status).toBe(200);

    for (const presented of [5, 4, 0]) {
      authenticator.signCount = presented;
      const refused = await refusedAssert(at, (challenge) =>
        authenticator.get({ challenge: challenge.challenge, origin: at.origin }),
      );
      expect([presented, refused]).toEqual([presented, { status: 401, code: "auth_invalid" }]);
    }
  });

  test("a credential built on rubbish is refused rather than faulted", async () => {
    const at = await serving();
    for (const attestation of ["oWNmbXQ", "AAAAAAAA", "_____w"]) {
      // A URL apiece: the first attempt spends the one it was made for, which
      // is what §2.2 asks of a registration URL.
      const issued = at.instance.auth.issue({ endpoint: servedAt(at) });
      const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
      const challenge = (await (await post(at, "challenge", {})).json()) as { challenge: string };
      const client = Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: challenge.challenge,
          origin: at.origin,
        }),
      ).toString("base64url");
      const response = await post(at, "register", {
        token,
        code: issued.code,
        credential: {
          id: "aaaa",
          raw_id: "aaaa",
          client_data_json: client,
          attestation_object: attestation,
        },
      });
      const body = (await response.json()) as { error?: { code?: string } };
      expect([attestation, response.status, body.error?.code]).toEqual([
        attestation,
        401,
        "auth_invalid",
      ]);
    }
  });

  test("a body missing a field the contract requires is invalid_args", async () => {
    const at = await serving();
    at.instance.auth.issue({ endpoint: servedAt(at) });
    const response = await post(at, "register", { token: "x" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_args",
    );
  });

  test("a POST carrying no Origin is refused", async () => {
    const at = await serving();
    const refused = await fetch(`http://${at.instance.http[0] as string}/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(403);
  });

  test("a browser that writes crossOrigin: false is admitted", async () => {
    // Chromium writes the field on every message. Reading its presence as a
    // refusal would turn away every credential those browsers make (C1).
    const at = await serving();
    const issued = at.instance.auth.issue({ endpoint: servedAt(at) });
    const authenticator = new SoftAuthenticator(issued.rp_id, { crossOrigin: false });
    const challenge = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
    const response = await post(at, "register", {
      token,
      code: issued.code,
      credential: await authenticator.create({
        challenge: challenge.challenge,
        origin: at.origin,
      }),
    });
    expect(response.status).toBe(200);
  });

  test("a registration URL naming an issuer this instance cannot ask is refused", async () => {
    // The registration travels to whoever issued the URL (§2.6). On an instance
    // with no mesh there is nobody to ask, so it is refused — and nothing is
    // spent: the real URL still works afterwards.
    const at = await serving();
    const issued = at.instance.auth.issue({ endpoint: servedAt(at) });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
    const [header, body, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(body as string, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const elsewhere = `${header ?? ""}.${Buffer.from(
      JSON.stringify({ ...claims, iss: "f".repeat(32) }),
    ).toString("base64url")}.${signature ?? ""}`;

    const first = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const refused = await post(at, "register", {
      token: elsewhere,
      code: issued.code,
      credential: await authenticator.create({
        challenge: first.challenge,
        origin: at.origin,
        userId: issued.user_id,
      }),
    });
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "auth_unknown_issuer",
    );

    // Neither the URL nor one of its five tries was spent.
    const second = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const ok = await post(at, "register", {
      token,
      code: issued.code,
      credential: await authenticator.create({
        challenge: second.challenge,
        origin: at.origin,
        userId: issued.user_id,
      }),
    });
    expect(ok.status).toBe(200);
  });
});

describe("the registration URL runs out (§2.2)", () => {
  test("five wrong codes spend the URL, and so does the expiry", () => {
    let now = 1_000_000;
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-url-"));
    const auth = new Auth({
      self: "0".repeat(32),
      records: new AuthRecords({ dir, self: "0".repeat(32), publish: () => {}, now: () => now }),
      endpoint: () => "http://ui.example/",
      unit: "unit",
      now: () => now,
    });
    const issued = auth.issue({});
    const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
    const wrong = issued.code === "000000" ? "111111" : "000000";
    // Four tries are refusals of the code; the fifth spends the URL itself, so
    // guessing costs the registration rather than one attempt.
    for (let i = 0; i < 4; i += 1) {
      expect(() => auth.resolveRegistration(token, wrong)).toThrow(/コードが違います/);
    }
    expect(() => auth.resolveRegistration(token, wrong)).toThrow(/再発行/);
    expect(() => auth.resolveRegistration(token, issued.code)).toThrow(/再発行/);

    // A fresh URL, left until its expiry, is gone the same way.
    const second = auth.issue({});
    const later = second.url.slice(second.url.indexOf("#register=") + "#register=".length);
    now = second.expires_at + 1;
    expect(() => auth.resolveRegistration(later, second.code)).toThrow(/期限切れ|再発行/);
  });

  test("the default subject is read from the records, not from a counter", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-sub-"));
    const records = new AuthRecords({ dir, self: "0".repeat(32), publish: () => {} });
    const deps = {
      self: "0".repeat(32),
      records,
      endpoint: () => "http://ui.example/" as const,
      unit: "unit",
    };
    records.write("credential/unit-3/abc", {
      kind: "credential",
      sub: "unit-3",
      credential_id: "abc",
      public_key: "k",
      user_handle: "u",
      endpoint: "http://ui.example/",
      registered_at: 1,
    });
    // A restart is a new Auth over the same records, and it must not hand the
    // next person a name somebody already holds (M11).
    expect(new Auth(deps).issue({}).sub).toBe("unit-4");
    expect(new Auth(deps).issue({}).sub).toBe("unit-4");
  });
});

describe("extending a connection (§2.5)", () => {
  test("a token of one's own extends it, and somebody else's does not", async () => {
    const at = await serving();
    const mine = at.instance.auth.mint("me");
    const theirs = at.instance.auth.mint("them");
    const client = await connectWs(at.instance.http[0] ?? "", mine.session.access.value);
    clients.push(client);
    client.send({ op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION });
    const greeting = (await client.next()) as { auth_expires_at: number };

    client.send({ op: "auth_refresh", request_id: "2", access_token: theirs.session.access.value });
    expect(await client.next()).toMatchObject({
      ok: false,
      request_id: "2",
      error: { code: "auth_invalid" },
    });

    const next = await at.instance.auth.refreshToken(mine.refresh.value);
    client.send({
      op: "auth_refresh",
      request_id: "3",
      access_token: next.session.access.value,
    });
    const extended = (await client.next()) as { ok: boolean; auth_expires_at: number };
    expect(extended.ok).toBe(true);
    expect(extended.auth_expires_at).toBeGreaterThanOrEqual(greeting.auth_expires_at);
  });

  test("a connection nobody extended is closed at its deadline", async () => {
    // The instance's own clock, moved rather than waited out: an access token
    // lasts hours, and what this is about is the deadline arriving on the path
    // it really arrives on — the timer the connection was held with.
    let now = Date.now();
    const at = await serving({ now: () => now });
    const minted = at.instance.auth.mint("brief");
    // Almost the whole life of the token has passed by the time the handshake
    // happens, so the connection is held with a deadline moments away.
    now = minted.session.access.expires_at - 60;

    const client = await connectWs(at.instance.http[0] ?? "", minted.session.access.value);
    client.send({ op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION });
    const greeting = (await client.next()) as { auth_expires_at: number };
    expect(greeting.auth_expires_at).toBe(minted.session.access.expires_at);

    now = minted.session.access.expires_at + 1;
    await client.whenClosed;
    expect(at.instance.auth.held.connections).toBe(0);
  });
});

describe("what a peer's records may and may not do (§2.4, §2.6)", () => {
  test("a peer cannot write a family this instance minted, nor revive a removal", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-merge-"));
    const self = "0".repeat(32);
    const records = new AuthRecords({ dir, self, publish: () => {} });
    const auth = new Auth({
      self,
      records,
      endpoint: () => undefined,
      unit: "unit",
    });
    const minted = auth.mint("someone");
    const [family] = records.families();
    records.fail(family?.key ?? "");
    expect(auth.admits(minted.session.access.value)).toBeUndefined();

    // The copy a peer still holds is older state about a family it may not
    // write, and taking it would undo the failure (M2).
    expect(
      records.merge([
        { key: family?.key ?? "", updated_at: Date.now() + 60_000, body: family?.body as never },
      ]).changed,
    ).toBe(0);
    expect(auth.admits(minted.session.access.value)).toBeUndefined();

    // A removal that arrived from a peer refuses the credential here too.
    records.write("credential/gone/abc", {
      kind: "credential",
      sub: "gone",
      credential_id: "abc",
      public_key: "k",
      user_handle: "u",
      endpoint: "http://ui.example/",
      registered_at: 1,
    });
    const removal = records.merge([
      {
        key: "credential/gone",
        updated_at: Date.now(),
        body: { kind: "tombstone", sub: "gone", deleted_at: Date.now() },
      },
    ]);
    expect(removal.removed).toEqual(["gone"]);
    expect(records.credentials()).toEqual([]);
    // And nothing brings it back.
    expect(
      records.merge([
        {
          key: "credential/gone/abc",
          updated_at: Date.now() + 60_000,
          body: {
            kind: "credential",
            sub: "gone",
            credential_id: "abc",
            public_key: "k",
            user_handle: "u",
            endpoint: "http://ui.example/",
            registered_at: 1,
          },
        },
      ]).changed,
    ).toBe(0);
  });
});

describe("the user handle a subject is known by (§2.2)", () => {
  test("the record keeps what the registration settled, and an assertion is held to it", async () => {
    const at = await serving();
    const { issued, authenticator } = await registered(at);
    const [record] = at.instance.auth.list();
    expect(record?.user_handle).toBe(issued.user_id);

    // The resident credential answers with that handle, and is admitted.
    const challenge = (await (await post(at, "challenge", {})).json()) as {
      challenge: string;
      issuer: string;
      expires_at: number;
    };
    const ok = await post(at, "assert", {
      credential: await authenticator.get({ challenge: challenge.challenge, origin: at.origin }),
      challenge,
    });
    expect(ok.status).toBe(200);

    // One naming somebody else is an authenticator answering for a credential
    // this record does not describe.
    const second = (await (await post(at, "challenge", {})).json()) as {
      challenge: string;
      issuer: string;
      expires_at: number;
    };
    authenticator.userHandle = Buffer.from("somebody else").toString("base64url");
    const refused = await post(at, "assert", {
      credential: await authenticator.get({ challenge: second.challenge, origin: at.origin }),
      challenge: second,
    });
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("auth_invalid");
  });

  test("a second URL for one subject reuses the handle that subject already has", async () => {
    const at = await serving();
    const { issued } = await registered(at);
    expect(at.instance.auth.issue({ endpoint: servedAt(at), sub: issued.sub }).user_id).toBe(
      issued.user_id,
    );
    // A different subject gets one of its own.
    expect(at.instance.auth.issue({ endpoint: servedAt(at) }).user_id).not.toBe(issued.user_id);
  });
});

describe("a credential is good for one endpoint (§2.3)", () => {
  test("a registration posted under another prefix than its endpoint is refused", async () => {
    const at = await serving();
    // The URL was issued for the instance at `/personal/`, and the browser
    // posts to the one at the root. Both are answered by this listener — the
    // routes are matched by the end of the path — so what tells them apart is
    // the endpoint the URL named (contract, `CredentialRecord.endpoint`).
    const issued = at.instance.auth.issue({ endpoint: `${servedAt(at)}personal/` });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const challenge = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const credential = await authenticator.create({
      challenge: challenge.challenge,
      origin: at.origin,
      userId: issued.user_id,
    });
    const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
    const body = { token, code: issued.code, credential };
    const elsewhere = await post(at, "register", body);
    expect(elsewhere.status).toBe(401);

    // The same registration, posted where the URL said, is taken.
    const here = await fetch(`http://${at.instance.http[0] as string}/personal/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: at.origin },
      body: JSON.stringify(body),
    });
    expect(here.status).toBe(200);
  });

  test("an endpoint that is not a base URL is refused where it is typed", async () => {
    const at = await serving();
    // An operator types this one. A URL naming a route, or missing the trailing
    // slash, would be written into a record and compared forever after against
    // a request that can never match it.
    expect(() => at.instance.auth.issue({ endpoint: `${servedAt(at)}ws` as never })).toThrow(
      /base URL/,
    );
    expect(() =>
      at.instance.auth.issue({ endpoint: "wss://h.example/personal/ws" as never }),
    ).toThrow(/base URL/);
  });
});

describe("where the registration URL points (§2.2)", () => {
  test("two endpoints on one host are two instances, told apart by their path", () => {
    // An endpoint is the instance's own base URL, so what a credential is good
    // for is that path and no other: a neighbour under the same host answers at
    // a different one and is a separate registration.
    expect(servesPath("https://h.example/personal/", "/personal/")).toBe(true);
    expect(servesPath("https://h.example/personal/", "/")).toBe(false);
    expect(servesPath("https://h.example/", "/")).toBe(true);
    expect(servesPath("https://h.example/", "/personal/")).toBe(false);
    // The origin is the other half, and says nothing about which of the two it
    // is: both endpoints share it.
    expect(originOf("https://h.example/personal/")).toBe("https://h.example");
    expect(originOf("https://h.example/")).toBe("https://h.example");
  });

  test("the URL a command issues is the page, with the token in its fragment", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-url-shape-"));
    const self = "0".repeat(32);
    const auth = new Auth({
      self,
      records: new AuthRecords({ dir, self, publish: () => {} }),
      endpoint: () => "https://h.example/personal/",
      unit: "unit",
    });
    const issued = auth.issue({});
    expect(issued.url.startsWith("https://h.example/personal/#register=")).toBe(true);
    expect(issued.rp_id).toBe("h.example");
  });
});
