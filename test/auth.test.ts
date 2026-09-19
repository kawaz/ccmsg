import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthAccountReadResult,
  type AuthRecord,
  type CredentialRecord,
  type InstanceId,
  type Origin,
  PROTOCOL_VERSION,
  REGISTER_TTL_MS,
  type UserId,
} from "@ccmsg/protocol";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import { OpError } from "../src/dispatch/index.ts";
import {
  ACCESS_KEEP_MS,
  ACCESS_TTL_MS,
  Auth,
  AuthRecords,
  authHandlers,
  claimsOf,
  credentialKey,
  cookieName,
  cookiePath,
  handleAdmin,
  handleAuth,
  PERSON_LABEL,
  PREVIOUS_GRACE_MS,
} from "../src/auth/index.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { connectWs, type LineClient } from "./client.ts";
import { TestConn } from "./frames.ts";
import { writeInstanceHome } from "./harness.ts";
import { leasePort } from "./mesh.ts";
import { knownAt, OTHER_USER, personSession, TEST_USER } from "./person.ts";

/** The person's authentication end to end (DR-0001, contract DR-0030): an
 * enrolment URL made on the machine, a person made against it with a passkey,
 * the instances they own, an assertion, the tokens that follow, and what
 * letting go of any of it does to the rest.
 *
 * Against a running instance rather than against the pieces, because the parts
 * that can be wrong are the joins: which route a browser reaches, what a cookie
 * carries, and what a WebSocket handshake presents. Where what decides a case
 * is a clock or an interleaving, `Auth` is driven over its records directly. */

const running: Instance[] = [];
const clients: LineClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
});

const SELF: InstanceId = "0".repeat(32);
const OTHER_INSTANCE: InstanceId = "f".repeat(32);
const ORIGIN: Origin = "https://ui.example";
const ENDPOINT = "https://ui.example/" as const;

/** An instance on an address reserved before its config is written.
 *
 * The page's origin has to be in the config before the listener is bound, and a
 * passkey is made for a host — so the kernel's address is settled first and the
 * origin, the endpoint and the relying party all follow from it, which is the
 * ordinary configuration. */
async function serving(
  options: { now?: () => number } = {},
): Promise<{ instance: Instance; origin: string }> {
  const lease = leasePort();
  const port = lease.port;
  const origin = `http://127.0.0.1:${String(port)}`;
  const root = mkdtempSync(join(tmpdir(), "ccmsg-auth-"));
  mkdirSync(join(root, "home", "sessions"), { recursive: true });
  writeInstanceHome(join(root, "config"), join(root, "home"), {
    entry: { host: "127.0.0.1", port },
  });
  const env: Env = {
    CLAUDE_CONFIG_DIR: join(root, "home"),
    CCMSG_STATE_DIR: join(root, "state"),
    CCMSG_CACHE_DIR: join(root, "cache"),
    CCMSG_CONFIG_DIR: join(root, "config"),
  };
  await lease.release();
  const outcome = await start({
    env,
    echoLog: false,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  return { instance: outcome, origin };
}

/** One `/auth/*` request, as the page would make it.
 *
 * The two headers a browser writes and a page's script cannot are stated as a
 * browser states them: the origin the page was served from, and a fetch that
 * did not come from outside a site (contract, DR-0028). `null` for either is a
 * request that carries no such header at all. */
async function post(
  at: { instance: Instance; origin: string },
  route: string,
  body: unknown,
  init: { cookie?: string; origin?: string | null; site?: string | null } = {},
): Promise<Response> {
  const site = init.site === undefined ? "same-origin" : init.site;
  const origin = init.origin === undefined ? at.origin : init.origin;
  return await fetch(`http://${at.instance.http[0] as string}/auth/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin === null ? {} : { origin }),
      ...(site === null ? {} : { "sec-fetch-site": site }),
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    body: JSON.stringify(body ?? {}),
  });
}

/** This instance's endpoint: the base URL it is served at, which an enrolment
 * URL names as where the page posts. An instance with no mesh has settled none
 * of its own (§7.1), so the URL is the caller's to state. */
function servedAt(at: { instance: Instance }): `http://${string}/` {
  return `http://${at.instance.http[0] as string}/`;
}

/** The token an enrolment URL carries in its fragment. */
function tokenOf(url: string): string {
  return url.slice(url.indexOf("#enroll=") + "#enroll=".length);
}

/** The whole of what a person does the first time: take the URL and the code
 * off the terminal, make a credential, and be signed in. Naming a person who
 * exists adds a passkey to them instead. */
async function registered(
  at: { instance: Instance; origin: string },
  options: {
    backup?: { eligible: boolean; state: boolean };
    user?: UserId;
    label?: string;
    name?: string;
    displayName?: string;
  } = {},
) {
  const issued = await at.instance.auth.issue({
    purpose: "create_user",
    endpoint: servedAt(at),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  const user = issued.user as UserId;
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
    userId: user,
  });
  const response = await post(at, "register", {
    token: tokenOf(issued.url),
    code: issued.code,
    device_label: "the laptop",
    ...(options.displayName === undefined ? {} : { display_name: options.displayName }),
    credential,
  });
  return { issued, user, authenticator, response };
}

/** One assertion, as the page would make it: a challenge from this instance,
 * answered by the authenticator and posted back. */
async function asserting(
  at: { instance: Instance; origin: string },
  authenticator: SoftAuthenticator,
  init: { origin?: string } = {},
): Promise<Response> {
  const challenge = (await (await post(at, "challenge", {})).json()) as {
    challenge: string;
    issuer: string;
    expires_at: number;
  };
  return await post(
    at,
    "assert",
    {
      credential: await authenticator.get({ challenge: challenge.challenge, origin: at.origin }),
      challenge,
    },
    init,
  );
}

/** A person signed in over the WebSocket, greeted and ready for an op. */
async function connected(
  at: { instance: Instance; origin: string },
  access: string,
): Promise<LineClient> {
  const client = await connectWs(at.instance.http[0] ?? "", access);
  clients.push(client);
  client.send({ op: "hello.user", request_id: "hello", protocol_version: PROTOCOL_VERSION });
  expect(await client.next()).toMatchObject({ ok: true });
  return client;
}

/** The code an op refused with, or nothing where it answered. Stated rather
 * than only that something was thrown: a session answered where a refusal was
 * due is what these are about. */
async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
    return undefined;
  } catch (cause) {
    if (cause instanceof OpError) return cause.code;
    throw cause;
  }
}

/** The refresh token a response set, as the browser would send it back. */
function mintedCookie(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.split(";")[0]?.split("=").slice(1).join("=") ?? "";
  return `${name}=${value}`;
}

/** A person's id of the contract's shape, the same for the same number: sixteen
 * bytes, whose base64url ends in one of the four characters that can carry the
 * last two bits (contract, `UserId`). For cases that need more people than the
 * two fixed ones. */
function person(n: number): UserId {
  return Buffer.alloc(16, n).toString("base64url");
}

/** `Auth` over its own records, on a clock the test may hold. */
function unit(
  options: { self?: InstanceId; endpoint?: string; now?: () => number; dir?: string } = {},
): { auth: Auth; records: AuthRecords; dir: string } {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "ccmsg-auth-unit-"));
  const self = options.self ?? SELF;
  const records = new AuthRecords({
    dir,
    publish: () => {},
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const auth = new Auth({
    self,
    records,
    endpoint: () => options.endpoint,
    unit: "unit",
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { auth, records, dir };
}

/** Several instances that carry one another's records, as a mesh would.
 *
 * What one writes is merged into the others, and the one op only an issuer can
 * answer is asked of whichever of them issued. The wire between them can be
 * cut, which is the only way to have two of them write one family without
 * seeing each other do it — and healed, which is the partition ending. */
function linked(
  instances: readonly { self: InstanceId; endpoint: string }[],
  options: { now?: () => number } = {},
): {
  peers: Auth[];
  cut: () => void;
  heal: () => Promise<void>;
  /** Every merge asked for so far has landed. */
  settled: () => Promise<void>;
} {
  const peers: Auth[] = [];
  let cut = false;
  const queued: { to: Auth; records: readonly AuthRecord[] }[] = [];
  const inflight: Promise<void>[] = [];
  const carry = (from: Auth, records: readonly AuthRecord[]): void => {
    for (const to of peers) {
      if (to === from) continue;
      if (cut) queued.push({ to, records });
      else inflight.push(to.merge(records));
    }
  };
  for (const { self, endpoint } of instances) {
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-linked-"));
    let auth: Auth | undefined;
    const records = new AuthRecords({
      dir,
      publish: (written) => {
        carry(auth as Auth, written);
      },
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    auth = new Auth({
      self,
      records,
      endpoint: () => endpoint,
      unit: self.slice(0, 4),
      // Each peer sees the whole set, which is what `--all` walks.
      instances: () =>
        instances.map((row) => ({
          id: row.self,
          endpoint: row.endpoint,
          host: "test",
          reachable: true,
        })),
      ask: (to, op, args) => {
        const target = peers.find((peer) => peer.self === to);
        if (target === undefined) {
          throw new OpError("instance_unreachable", `${to} cannot be reached`);
        }
        const handler = authHandlers(target)[op as keyof ReturnType<typeof authHandlers>];
        return Promise.resolve(handler({ op: op as never, conn: new TestConn(), args }));
      },
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    peers.push(auth);
  }
  const settled = async (): Promise<void> => {
    await Promise.all(inflight.splice(0));
  };
  return {
    peers,
    cut: () => {
      cut = true;
    },
    heal: async () => {
      cut = false;
      for (const { to, records } of queued.splice(0)) inflight.push(to.merge(records));
      await settled();
    },
    settled,
  };
}

/** A person made at one `Auth`, with the passkey that answers for them. */
async function registeredAt(auth: Auth, options: { origin?: Origin; user?: UserId } = {}) {
  const issued = await auth.issue({
    purpose: "create_user",
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.user === undefined ? {} : { user: options.user }),
  });
  const user = issued.user as UserId;
  const authenticator = new SoftAuthenticator(issued.rp_id);
  const challenge = await auth.challenge();
  const credential = await authenticator.create({
    challenge: challenge.challenge,
    origin: issued.origin,
    userId: user,
  });
  const minted = await auth.register({ token: tokenOf(issued.url), code: issued.code, credential });
  return { issued, user, authenticator, minted };
}

describe("what an enrolment URL hands over (contract, `EnrollClaims.instances`)", () => {
  test("the set is decided where the URL was made, and written where the ceremony lands", async () => {
    const { peers, settled } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    // Asked for at this terminal, where "the peers this instance knows of" is a
    // question a person can see the answer to.
    const issued = await here.issue({ purpose: "create_user", origin: ORIGIN, all: true });
    expect(issued.instances).toEqual([SELF, OTHER_INSTANCE]);
    // Nothing is granted yet: a URL nobody spends leaves no granting behind.
    expect(here.records.ownerships()).toEqual([]);

    // The ceremony lands on the peer, which knows nothing of what was asked for
    // here and reads it out of the claims.
    const user = issued.user as UserId;
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const challenge = await here.challenge();
    const credential = await authenticator.create({
      challenge: challenge.challenge,
      origin: issued.origin,
      userId: user,
    });
    await next.register({
      token: tokenOf(issued.url),
      code: issued.code,
      challenge,
      credential,
    });
    await settled();
    for (const auth of [here, next]) {
      expect(auth.records.owns(user, SELF)).toBe(true);
      expect(auth.records.owns(user, OTHER_INSTANCE)).toBe(true);
    }
    // Who decided is the instance that made the URL, not the one the answer
    // happened to reach.
    for (const record of next.records.ownerships()) {
      expect(record.granted_by).toEqual({ kind: "instance", instance: SELF });
    }
  });

  test("a URL naming nothing hands over the one instance that issued it", async () => {
    const { peers } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here] = peers as [Auth, Auth];
    const issued = await here.issue({ purpose: "create_user", origin: ORIGIN });
    expect(issued.instances).toEqual([SELF]);
    const { user } = await registeredAt(here, { origin: ORIGIN });
    expect(here.records.owns(user, SELF)).toBe(true);
    expect(here.records.owns(user, OTHER_INSTANCE)).toBe(false);
  });
});

describe("making a person (contract, DR-0030 §4)", () => {
  test("the URL and the code are two halves, and only both together register", async () => {
    const at = await serving();
    const issued = await at.instance.auth.issue({ purpose: "create_user", endpoint: servedAt(at) });
    // The code is not in the URL: a leaked URL is not a registration.
    expect(issued.url).not.toContain(issued.code);
    expect(issued.url).toContain("#enroll=");

    const authenticator = new SoftAuthenticator(issued.rp_id);
    const wrong = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const refused = await post(at, "register", {
      token: tokenOf(issued.url),
      code: issued.code === "000000" ? "111111" : "000000",
      credential: await authenticator.create({
        challenge: wrong.challenge,
        origin: at.origin,
        userId: issued.user,
      }),
    });
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("auth_invalid");
    // Nothing of the person was written by the attempt: the granting the URL
    // came with stands, and admits nobody until they exist.
    expect(at.instance.auth.records.user(issued.user as UserId)).toBeUndefined();
    expect(at.instance.auth.records.credentials()).toEqual([]);
  });

  test("the name the URL carries is what the authenticator is told to call the account", async () => {
    // A passkey manager keeps the account name the ceremony was given and shows
    // it wherever the key is listed, so the page reads it off the claims rather
    // than putting the handle there — sixteen random bytes is the one thing a
    // person must not see in that list. What the operator wrote is the starting
    // point, and it is apart from the note about who the URL was handed to.
    const at = await serving();
    const named = await registered(at, { name: "kawaz", label: "handed to kawaz in person" });
    const claims = claimsOf(named.issued.url.split("#enroll=")[1] as string);
    // Two values, and they stay two: one is what the person is called, the
    // other an administrator's note about who the URL went to. A single field
    // doing both would show the note to the person as their own name.
    expect(claims.display_name).toBe("kawaz");
    expect(claims.issued_label).toBe("handed to kawaz in person");
    expect(at.instance.auth.records.user(named.user)?.display_name).toBe("kawaz");
    // The note stays on the passkey as the note it is, and nowhere else.
    expect(at.instance.auth.credentials(named.user)[0]?.issued_label).toBe(
      "handed to kawaz in person",
    );

    // A note with no name suggested leaves the name unsaid: the note is not
    // a fallback for it.
    const noted = await serving();
    const memo = await registered(noted, { label: "the spare key" });
    expect(claimsOf(memo.issued.url.split("#enroll=")[1] as string).display_name).toBeUndefined();
    expect(noted.instance.auth.records.user(memo.user)?.display_name).toBe(PERSON_LABEL);

    // What the person settled on the form is what stands over the URL's guess.
    const said = await serving();
    const settled = await registered(said, { name: "guessed", displayName: "kawaz" });
    expect(said.instance.auth.records.user(settled.user)?.display_name).toBe("kawaz");

    // Nothing said anywhere, and the short default stands rather than an empty
    // name.
    const plain = await serving();
    const anonymous = await registered(plain);
    expect(plain.instance.auth.records.user(anonymous.user)?.display_name).toBe(PERSON_LABEL);

    // A second URL for somebody who exists carries the name they read
    // themselves by, so a manager asked to store a second passkey stores it
    // under the same account. Registering against it does not rename them.
    await at.instance.auth.rename(named.user, "kawaz (work)");
    const again = await registered(at, { user: named.user, displayName: "something else" });
    expect(claimsOf(again.issued.url.split("#enroll=")[1] as string).display_name).toBe(
      "kawaz (work)",
    );
    expect(at.instance.auth.records.user(named.user)?.display_name).toBe("kawaz (work)");
  });

  test("a registration makes the person, their passkey and their granting, and signs them in", async () => {
    const at = await serving();
    const { response, user, authenticator } = await registered(at);
    expect(response.status).toBe(200);
    const session = (await response.json()) as { user: string; access: { value: string } };
    expect(session.user).toBe(user);
    expect(session.access.value.length).toBeGreaterThan(20);
    // The refresh token is a cookie and is in no body a page can read.
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(cookieName(user));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Path=${cookiePath("/auth/register")}`);
    expect(JSON.stringify(session)).not.toContain(cookie.split(";")[0]?.split("=")[1] ?? "!");

    // The three records one registration leaves: the person, keyed by the
    // handle the authenticator holds; the passkey, naming them and the origin
    // it was made at; and the granting of the instance the URL handed over,
    // written now that the ceremony stands.
    const { records } = at.instance.auth;
    expect(records.user(user)).toMatchObject({ kind: "user", user });
    const [record] = records.credentials();
    expect(record).toMatchObject({
      user,
      origin: at.origin,
      credential_id: authenticator.credentialIdUrl,
      device_label: "the laptop",
    });
    expect(typeof record?.registered_user_agent).toBe("string");
    expect(records.owns(user, at.instance.self)).toBe(true);
    expect(records.ownerships()).toMatchObject([
      {
        user,
        instance: at.instance.self,
        granted_by: { kind: "instance", instance: at.instance.self },
      },
    ]);
  });

  test("a second URL naming the person adds a passkey to them, and nothing else grows", async () => {
    const at = await serving();
    const first = await registered(at);
    const second = await registered(at, { user: first.user });
    expect(second.response.status).toBe(200);
    expect(second.issued.user).toBe(first.user);

    const { records } = at.instance.auth;
    expect(records.users().map((held) => held.user)).toEqual([first.user]);
    expect(records.credentials().map((held) => held.user)).toEqual([first.user, first.user]);
    expect(records.ownerships()).toHaveLength(1);
    // Both passkeys answer for the one person.
    for (const authenticator of [first.authenticator, second.authenticator]) {
      const answer = await asserting(at, authenticator);
      expect(answer.status).toBe(200);
      expect(((await answer.json()) as { user: string }).user).toBe(first.user);
    }
  });

  test("what the authenticator said about backing the credential up is on the line the person reads", async () => {
    const at = await serving();
    // Two keys, which is the whole point of keeping the flags: one that syncs
    // across the person's devices, and one that exists only on the stick it was
    // made on. Removing the second costs them the key; removing the first does
    // not, and nothing else on the line says which is which.
    const { user } = await registered(at, { backup: { eligible: true, state: true } });
    await registered(at, { user, backup: { eligible: false, state: false } });
    const answer = await handleAdmin(
      { auth: at.instance.auth },
      { admin: "passkey_list", request_id: "asking", user },
    );
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

  test("the enrolment URL is spent, so the same one cannot register twice", async () => {
    const at = await serving();
    const { issued, authenticator } = await registered(at);
    const again = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const refused = await post(at, "register", {
      token: tokenOf(issued.url),
      code: issued.code,
      credential: await authenticator.create({ challenge: again.challenge, origin: at.origin }),
    });
    expect(refused.status).toBe(401);
  });

  test("a URL is spent for the purpose it names, and for no other", async () => {
    // A URL that adds an owner is not a registration, and one that makes a
    // person is not an addition: the claims say which, and the op holds the
    // URL to it before anything is spent.
    const { auth } = unit({ endpoint: ENDPOINT });
    const { authenticator } = await registeredAt(auth);
    const adding = await auth.issue({ purpose: "add_owner" });
    const creating = await auth.issue({ purpose: "create_user" });

    const challenge = await auth.challenge();
    expect(
      await refusal(
        auth.register({
          token: tokenOf(adding.url),
          code: adding.code,
          credential: await authenticator.create({
            challenge: challenge.challenge,
            origin: ORIGIN,
          }),
        }),
      ),
    ).toBe("auth_invalid");
    expect(
      await refusal(
        auth.enroll({
          token: tokenOf(creating.url),
          code: creating.code,
          challenge,
          credential: await authenticator.get({ challenge: challenge.challenge, origin: ORIGIN }),
        }),
      ),
    ).toBe("auth_invalid");
    // Neither URL was spent by being presented to the wrong op.
    expect(auth.heldCounts.pending).toBe(2);
    expect(auth.heldCounts.challenges).toBe(1);
  });
});

describe("taking an instance as one's own (contract, DR-0030 §4)", () => {
  test("an existing passkey and the six digits hand the person the instance, and a second time changes nothing", async () => {
    const { peers, settled } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    const { user, authenticator } = await registeredAt(here);
    await settled();
    // The mesh carried the person to the second instance, and nothing there
    // admits them yet: knowing of somebody is not owning anything.
    expect(next.records.credential(authenticator.credentialIdUrl)).toBeDefined();
    expect(next.records.owns(user, next.self)).toBe(false);

    // The URL is the second instance's, and sends the person to the page their
    // passkey lives at; the six digits are what say the person in front of the
    // authenticator chose this instance, which the assertion alone cannot.
    const enrol = async (code?: string): Promise<string | undefined> => {
      const issued = await next.issue({ purpose: "add_owner", origin: ORIGIN });
      expect(issued.user).toBeUndefined();
      const challenge = await next.challenge();
      return await refusal(
        next.enroll({
          token: tokenOf(issued.url),
          code: code ?? issued.code,
          challenge,
          credential: await authenticator.get({ challenge: challenge.challenge, origin: ORIGIN }),
        }),
      );
    };
    expect(await enrol("000000")).toBe("auth_invalid");
    expect(next.records.owns(user, next.self)).toBe(false);

    expect(await enrol()).toBeUndefined();
    expect(next.records.owns(user, next.self)).toBe(true);
    const [granting] = next.records.grantsOf(user, next.self);
    // The instance that issued the URL, as a registration's is: what the list
    // says is where the decision was made, not who happened to answer.
    expect(granting?.body.granted_by).toEqual({ kind: "instance", instance: next.self });
    // No passkey was made: an instance is not something a credential is for.
    expect(next.records.credentials()).toHaveLength(1);

    // Already an owner: a success that writes nothing, because a refusal would
    // read to the person as a mistyped code.
    expect(await enrol()).toBeUndefined();
    expect(next.records.grantsOf(user, next.self)).toHaveLength(1);
    // And the session it answered admits the person here, and the granting
    // reached the first instance like every record does.
    await settled();
    expect(here.records.owns(user, next.self)).toBe(true);
  });

  test("a passkey nobody registered adds nothing, and the URL is still good", async () => {
    const { auth } = unit({ endpoint: ENDPOINT });
    const stranger = new SoftAuthenticator("ui.example");
    stranger.userHandle = OTHER_USER;
    const issued = await auth.issue({ purpose: "add_owner" });
    const challenge = await auth.challenge();
    expect(
      await refusal(
        auth.enroll({
          token: tokenOf(issued.url),
          code: issued.code,
          challenge,
          credential: await stranger.get({ challenge: challenge.challenge, origin: ORIGIN }),
        }),
      ),
    ).toBe("auth_invalid");
    expect(auth.records.ownerships()).toEqual([]);
    // Refused before the URL was asked about, so neither it nor its challenge
    // was spent on a credential that verified nothing.
    expect(auth.heldCounts).toMatchObject({ pending: 1, challenges: 1 });
  });
});

describe("authenticating and the tokens that follow (§2.5; contract, DR-0030 §5)", () => {
  test("an assertion mints a session, and the WebSocket takes its token", async () => {
    const at = await serving();
    const { user, authenticator } = await registered(at);

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
    const session = (await asserted.json()) as { user: string; access: { value: string } };
    expect(session.user).toBe(user);

    const client = await connectWs(at.instance.http[0] ?? "", session.access.value);
    clients.push(client);
    client.send({ op: "hello.user", request_id: "1", protocol_version: PROTOCOL_VERSION });
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

  test("refreshing rotates, and a generation the family retired fails it", async () => {
    const at = await serving();
    // A passkey at this origin is what makes it one the refresh route answers
    // for, and the granting is what admits the person (contract, DR-0030 §9).
    await knownAt(at.instance.auth, at.origin);
    const first = await at.instance.auth.mint(TEST_USER, at.origin);
    const name = cookieName(TEST_USER);
    const zero = `${name}=${first.refresh.value}`;

    const one = await post(at, "refresh", {}, { cookie: zero });
    expect(one.status).toBe(200);
    const next = (await one.json()) as { user: string; access: { value: string } };
    expect(next.user).toBe(TEST_USER);
    // The cookie turned over; the access token is the family's one token and is
    // answered as it stands, because the person's other pages are holding it.
    expect(next.access.value).toBe(first.session.access.value);
    const firstRotation = mintedCookie(one, name);
    expect(firstRotation).not.toBe(zero);

    // The generation before the standing one is answered rather than refused: a
    // reply lost on the way is a retry, not a replay, and it is answered with
    // the pair the caller missed rather than by rotating again.
    expect((await post(at, "refresh", {}, { cookie: zero })).status).toBe(200);

    const two = await post(at, "refresh", {}, { cookie: firstRotation });
    expect(two.status).toBe(200);
    const standing = mintedCookie(two, name);

    // A value no family ever issued is refused and fails nothing: the family
    // that is standing goes on standing.
    expect(
      (await post(at, "refresh", {}, { cookie: `${name}=not-a-token-anybody-minted` })).status,
    ).toBe(401);
    expect(at.instance.auth.admits(first.session.access.value)?.user).toBe(TEST_USER);

    // Two generations back is past every grace, and the family remembers what
    // it rotated away — so this is a token being reused, and the family goes
    // with it, standing token included.
    expect((await post(at, "refresh", {}, { cookie: zero })).status).toBe(401);
    expect((await post(at, "refresh", {}, { cookie: standing })).status).toBe(401);
    expect(at.instance.auth.admits(first.session.access.value)).toBeUndefined();
  });

  test("a refresh states why it was asked for, and the family keeps the last one", async () => {
    const { auth, records } = unit({ endpoint: "https://ui.example.com/" });
    await knownAt(auth, "https://ui.example.com");
    const minted = await auth.mint(TEST_USER, "https://ui.example.com");
    const name = cookieName(TEST_USER);

    const refresh = async (value: string, body: unknown) =>
      await handleAuth(
        new Request("https://ui.example.com/auth/refresh", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://ui.example.com",
            "sec-fetch-site": "same-origin",
            "user-agent": "a browser",
            cookie: `${name}=${value}`,
          },
          body: JSON.stringify(body),
        }),
        { auth, self: SELF },
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
});

describe("the origins this instance answers for (contract, DR-0030 §9)", () => {
  test("making a person answers any page, and the rest only the pages this instance holds a passkey at", async () => {
    const at = await serving();
    await registered(at);
    const stranger = "http://elsewhere.example";
    const preflight = async (route: string, origin: string): Promise<number> =>
      (
        await fetch(`http://${at.instance.http[0] as string}/auth/${route}`, {
          method: "OPTIONS",
          headers: { origin },
        })
      ).status;
    // Making a person begins where no passkey names that origin yet, so there
    // is no set to compare the caller against: what guards it is the token, the
    // digits and the issuer's count of tries.
    for (const route of ["challenge", "register"]) {
      expect([route, await preflight(route, stranger)]).toEqual([route, 204]);
    }
    // The rest are answered only for pages this instance holds a passkey at.
    // `enroll` is among them: it is answerable only where the credential has
    // already replicated, so the origin to compare against is exactly what such
    // an instance has.
    for (const route of ["enroll", "assert", "refresh", "signout"]) {
      expect([route, await preflight(route, stranger)]).toEqual([route, 403]);
      expect([route, await preflight(route, at.origin)]).toEqual([route, 204]);
    }
    // A challenge is answered to the stranger; a registration is read as far as
    // its body, which is the gate having been passed; an assertion is refused
    // before anything is read.
    expect((await post(at, "challenge", {}, { origin: stranger })).status).toBe(200);
    const registration = await post(at, "register", {}, { origin: stranger });
    expect(registration.status).toBe(400);
    expect(((await registration.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_args",
    );
    expect((await post(at, "enroll", {}, { origin: stranger })).status).toBe(403);
    expect((await post(at, "assert", {}, { origin: stranger })).status).toBe(403);
    expect((await post(at, "refresh", {}, { origin: stranger })).status).toBe(403);
    expect((await post(at, "signout", {}, { origin: stranger })).status).toBe(403);
  });

  test("a preflight from a page an owner made a passkey at is answered with credentials allowed", async () => {
    const at = await serving();
    // What makes this instance answer for that page is a passkey one of its
    // owners made there: no list of origins is configured.
    await registered(at);
    const answer = await fetch(`http://${at.instance.http[0] as string}/auth/assert`, {
      method: "OPTIONS",
      headers: { origin: at.origin },
    });
    expect(answer.status).toBe(204);
    expect(answer.headers.get("access-control-allow-origin")).toBe(at.origin);
    expect(answer.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("an origin enters the set with its first passkey, and ownership does not narrow it", async () => {
    const { auth } = unit({ endpoint: ENDPOINT });
    expect(auth.knownOrigins()).toEqual([]);
    // A passkey that arrived by replication puts its page in the set even
    // though nobody owns this instance yet. That is the point: an enrolment is
    // answered at exactly such an instance, and a set narrowed by ownership
    // would refuse its preflight.
    await auth.records.write(credentialKey("stranger"), {
      kind: "credential",
      user: OTHER_USER,
      credential_id: "stranger",
      public_key: "AA",
      origin: "https://elsewhere.example",
      registered_at: 1,
    });
    expect(auth.knownOrigins()).toEqual(["https://elsewhere.example"]);
    // Whether the person may enter is the ownership's answer, and it is asked
    // elsewhere: letting the instance go leaves the page known and the door
    // shut.
    await auth.grant(OTHER_USER, [SELF], { kind: "instance", instance: SELF });
    await auth.revoke(OTHER_USER, SELF);
    expect(auth.knownOrigins()).toEqual(["https://elsewhere.example"]);
    expect(auth.records.owns(OTHER_USER, SELF)).toBe(false);
    // Nothing is added by issuing a URL: the origin it names is one `register`
    // already answers, and the rest have nothing to compare a page there with
    // until a passkey exists.
    await auth.issue({ purpose: "create_user", origin: "https://ui.example.test" });
    expect(auth.knownOrigins()).toEqual(["https://elsewhere.example"]);
    // Removing the last passkey naming it is the one way a page leaves.
    await auth.removeCredential(OTHER_USER, "stranger");
    expect(auth.knownOrigins()).toEqual([]);
  });

  test("a sibling of this instance's own host is not this instance", async () => {
    // The relying party is a domain, so every host under it is one an
    // authenticator will answer for. That is not who may read these answers:
    // `/auth/refresh` hands back an access token, and a browser attaches the
    // cookie for it by domain, so a neighbour let in on the domain alone would
    // read the person's token. The comparison is of whole origins.
    const { auth } = unit({ endpoint: "https://ui.example.com/" });
    await knownAt(auth, "https://ui.example.com");
    expect(auth.knownOrigins()).toEqual(["https://ui.example.com"]);
    const preflight = async (origin: string) =>
      (
        await handleAuth(
          new Request("https://ui.example.com/auth/refresh", {
            method: "OPTIONS",
            headers: { origin },
          }),
          { auth, self: SELF },
        )
      )?.status;
    expect(await preflight("https://evil.example.com")).toBe(403);
    expect(await preflight("https://example.com")).toBe(403);
    // A different port is a different origin, and so is a different scheme.
    expect(await preflight("https://ui.example.com:8443")).toBe(403);
    expect(await preflight("http://ui.example.com")).toBe(403);
    expect(await preflight("https://ui.example.com")).toBe(204);
  });

  test("the first registration at a page happens where no passkey names it yet", async () => {
    // An instance that has never heard of the page: the URL names it, the
    // browser at it posts, and the registration is what puts the origin in the
    // set — which is the whole of how an origin ever enters it.
    const { auth } = unit({ endpoint: "https://h.example/" });
    const issued = await auth.issue({ purpose: "create_user", origin: "https://ui.example.test" });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const challenge = await auth.challenge();
    const answer = await handleAuth(
      new Request("https://h.example/auth/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://ui.example.test",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({
          token: tokenOf(issued.url),
          code: issued.code,
          credential: await authenticator.create({
            challenge: challenge.challenge,
            origin: "https://ui.example.test",
            userId: issued.user,
          }),
        }),
      }),
      { auth, self: SELF },
    );
    expect(answer?.status).toBe(200);
    expect(auth.knownOrigins()).toEqual(["https://ui.example.test"]);
  });
});

describe("a person is admitted only to the instances they own (contract, DR-0030 §3)", () => {
  test("a passkey the mesh carried opens nothing at an instance the person does not own", async () => {
    const { peers, settled } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    const { user, authenticator, minted } = await registeredAt(here);
    await settled();

    const asserting = async (auth: Auth): Promise<string | undefined> => {
      const challenge = await auth.challenge();
      return await refusal(
        auth.assert({
          credential: await authenticator.get({ challenge: challenge.challenge, origin: ORIGIN }),
          challenge,
        }),
      );
    };
    // The record is there and verifies; what is missing is the granting.
    expect(next.records.credential(authenticator.credentialIdUrl)).toBeDefined();
    expect(await asserting(next)).toBe("auth_invalid");
    expect(await refusal(next.refreshToken(minted.refresh.value))).toBe("auth_invalid");
    expect(next.admits(minted.session.access.value)).toBeUndefined();
    // Which endpoint was reached is not what refused it: the same at home.
    expect(await asserting(here)).toBeUndefined();
    expect(here.admits(minted.session.access.value)?.user).toBe(user);

    // One granting, written from the other instance — the peers trust each
    // other equally — and everything the person holds works at the second one.
    await here.grant(user, [next.self], { kind: "instance", instance: here.self });
    await settled();
    expect(await asserting(next)).toBeUndefined();
    expect((await next.refreshToken(minted.refresh.value)).session.user).toBe(user);
    expect(next.admits(minted.session.access.value)?.user).toBe(user);
  });

  test("a handshake with the token of somebody who does not own this instance is refused", async () => {
    const at = await serving();
    // A token says who the person is and nothing about what they own: minted
    // here, for a person nothing has granted this instance to.
    const minted = await at.instance.auth.mint(OTHER_USER, at.origin);
    const address = at.instance.http[0] ?? "";
    const outcome = await connectWs(address, minted.session.access.value).then(
      async (opened) => {
        await opened.close();
        return "opened";
      },
      () => "refused",
    );
    expect(outcome).toBe("refused");
    await at.instance.auth.grant(OTHER_USER, [at.instance.self], {
      kind: "instance",
      instance: at.instance.self,
    });
    const client = await connectWs(address, minted.session.access.value);
    clients.push(client);
    client.send({ op: "hello.user", request_id: "1", protocol_version: PROTOCOL_VERSION });
    expect(await client.next()).toMatchObject({ ok: true });
  });
});

describe("letting an instance go, and taking it again (contract, DR-0030 §3)", () => {
  test("the granting is marked, the connection closes, and a new granting is not refused by the mark", async () => {
    const at = await serving();
    const { user, authenticator } = await registered(at);
    const session = (await (await asserting(at, authenticator)).json()) as {
      access: { value: string };
    };
    const client = await connected(at, session.access.value);
    const { auth } = at.instance;
    const [before] = auth.records.grantsOf(user, at.instance.self);
    expect(before).toBeDefined();

    const removed = await handleAdmin(
      { auth },
      { admin: "user_remove", request_id: "removing", user },
    );
    expect(removed).toMatchObject({ kind: "reply", response: { released: [at.instance.self] } });
    await client.whenClosed;
    expect(auth.records.owns(user, at.instance.self)).toBe(false);
    expect(auth.records.removed(before?.key ?? "")).toBe(true);
    // The tokens the person holds open nothing here now, and neither does the
    // passkey — which still exists, the person having lost an instance and not
    // a key. The page is still one this instance knows, the passkey naming it
    // being right there, so the request is read; what refuses it is the
    // ownership, which is the question CORS was never asked.
    expect(auth.admits(session.access.value)).toBeUndefined();
    expect(auth.records.credential(authenticator.credentialIdUrl)).toBeDefined();
    const turned = await asserting(at, authenticator);
    expect(turned.status).toBe(401);
    expect(((await turned.json()) as { error: { code: string } }).error.code).toBe("auth_invalid");
    const direct = await auth.challenge();
    expect(
      await refusal(
        auth.assert({
          credential: await authenticator.get({ challenge: direct.challenge, origin: at.origin }),
          challenge: direct,
        }),
      ),
    ).toBe("auth_invalid");

    // A peer that missed the removal carries the old granting back as news,
    // and the mark refuses it.
    const stale: AuthRecord = {
      key: before?.key ?? "",
      updated_at: Date.now() + 60_000,
      body: before?.body as AuthRecord["body"],
    };
    expect((await auth.records.merge([stale])).changed).toBe(0);
    expect(auth.records.owns(user, at.instance.self)).toBe(false);

    // Given the instance back: a granting under a key of its own, which no
    // mark stands over. The person is in again, on the same passkey.
    const added = await handleAdmin({ auth }, { admin: "user_add", request_id: "adding", user });
    expect(added).toMatchObject({ kind: "reply", response: { granted: [at.instance.self] } });
    const [after] = auth.records.grantsOf(user, at.instance.self);
    expect(after?.key).not.toBe(before?.key);
    expect(auth.records.removed(before?.key ?? "")).toBe(true);
    expect(auth.records.owns(user, at.instance.self)).toBe(true);
    const again = await asserting(at, authenticator);
    expect(again.status).toBe(200);
    const next = (await again.json()) as { access: { value: string } };
    await connected(at, next.access.value);
  });

  test("any mark a peer wrote about a person closes the connections they hold here", async () => {
    const { peers, settled } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    await knownAt(here, ORIGIN);
    await here.grant(TEST_USER, [next.self], { kind: "instance", instance: here.self });
    const minted = await here.mint(TEST_USER, ORIGIN);
    await settled();
    const conn = new TestConn();
    let closed = false;
    conn.onClose(() => {
      closed = true;
    });
    here.hold(
      conn,
      here.admits(minted.session.access.value) as { user: UserId; expiresAt: number },
    );
    expect(here.heldCounts.connections).toBe(1);

    // A granting of the *other* instance, marked over there. The person still
    // owns this one, and the connection still goes: a mark is read as being
    // about the person rather than about the instance it named, because the
    // one that matters most — a family failed where a replay was seen — says
    // nothing about ownership at all. Signing in again is the cost, and it is
    // one verification.
    await next.revoke(TEST_USER, next.self);
    await settled();
    expect(closed).toBe(true);
    expect(here.heldCounts.connections).toBe(0);
    // The token itself is untouched: what they lost was a granting elsewhere.
    expect(here.admits(minted.session.access.value)?.user).toBe(TEST_USER);

    // And the granting this connection was admitted on, marked over there: the
    // token stops admitting anybody too.
    await next.revoke(TEST_USER, here.self);
    await settled();
    expect(here.admits(minted.session.access.value)).toBeUndefined();
  });

  test("a family failed where the replay was seen closes the connections it opened here", async () => {
    // The replay is detected at whichever instance the retired value was
    // presented to, and behind a load balancer that is not where the pages are
    // connected. A mark that only revoked tokens would leave the stolen
    // session live on every peer for the rest of the access token's life,
    // which is the whole of what replicating the mark is for.
    let now = 2_000_000;
    const { peers, settled } = linked(
      [
        { self: SELF, endpoint: ENDPOINT },
        { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
      ],
      { now: () => now },
    );
    const [here, next] = peers as [Auth, Auth];
    await knownAt(here, ORIGIN);
    await here.grant(TEST_USER, [next.self], { kind: "instance", instance: here.self });
    const minted = await here.mint(TEST_USER, ORIGIN);
    await settled();
    const conn = new TestConn();
    let closed = false;
    conn.onClose(() => {
      closed = true;
    });
    here.hold(
      conn,
      here.admits(minted.session.access.value) as { user: UserId; expiresAt: number },
    );

    // Rotated here, replayed over there, past the grace that answers a retry.
    now += 1;
    await here.refreshToken(minted.refresh.value);
    await settled();
    now += PREVIOUS_GRACE_MS + 1;
    expect(await refusal(next.refreshToken(minted.refresh.value))).toBe("auth_invalid");
    await settled();

    expect(closed).toBe(true);
    expect(here.heldCounts.connections).toBe(0);
    expect(here.admits(minted.session.access.value)).toBeUndefined();
    // The person still owns this instance: what ended was the family.
    expect(here.records.owns(TEST_USER, here.self)).toBe(true);
  });
});

describe("rotating wherever the refresh lands (contract, DR-0030 §5)", () => {
  test("an instance that did not mint the family rotates it, and the minting one reads the rotation back", async () => {
    const { peers, settled } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    await knownAt(here, ORIGIN);
    await here.grant(TEST_USER, [next.self], { kind: "instance", instance: here.self });
    const minted = await here.mint(TEST_USER, ORIGIN);
    await settled();

    const rotated = await next.refreshToken(minted.refresh.value, { reason: "reconnect" });
    expect(rotated.session.user).toBe(TEST_USER);
    await settled();
    // Written where it landed and carried back: the minting instance holds the
    // rotation as though it had made it, `iss` saying only where the family
    // came from.
    const [family] = here.records.families();
    expect(family?.body.iss).toBe(SELF);
    expect(family?.body.refresh.value).toBe(rotated.refresh.value);
    expect(family?.body.last_refresh?.reason).toBe("reconnect");
    expect((await here.refreshToken(rotated.refresh.value)).session.user).toBe(TEST_USER);
  });

  test("of two rotations apart, the loser's value is refused and the family stands; only a retired value fails it", async () => {
    let now = 1_000_000;
    const { peers, cut, heal, settled } = linked(
      [
        { self: SELF, endpoint: ENDPOINT },
        { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
      ],
      { now: () => now },
    );
    const [here, next] = peers as [Auth, Auth];
    await knownAt(here, ORIGIN);
    await here.grant(TEST_USER, [next.self], { kind: "instance", instance: here.self });
    const minted = await here.mint(TEST_USER, ORIGIN);
    await settled();

    // Partitioned, each rotates the value the person's two pages presented.
    cut();
    now += 1;
    const lost = await here.refreshToken(minted.refresh.value);
    now += 1;
    const won = await next.refreshToken(minted.refresh.value);
    await heal();
    // The later write is what both hold once the partition ends.
    for (const auth of [here, next]) {
      expect(auth.records.byRefresh(won.refresh.value)?.previous).toBe(false);
      expect(auth.records.byRefresh(lost.refresh.value)).toBeUndefined();
    }

    // The losing page holds a value no generation of the family names — not
    // the standing one, not the one in grace, not a retired digest. It is
    // refused, and nothing else happens: the winner's page goes on, and so do
    // the pages holding the access token.
    expect(await refusal(here.refreshToken(lost.refresh.value))).toBe("auth_invalid");
    expect(await refusal(next.refreshToken(lost.refresh.value))).toBe("auth_invalid");
    expect(here.admits(minted.session.access.value)?.user).toBe(TEST_USER);
    expect(next.admits(minted.session.access.value)?.user).toBe(TEST_USER);
    expect((await here.refreshToken(won.refresh.value)).session.user).toBe(TEST_USER);
    await settled();

    // The value both rotated away, past its grace, is the one thing that fails
    // the family: that is a replay, wherever it is presented.
    now += PREVIOUS_GRACE_MS + 1;
    expect(await refusal(next.refreshToken(minted.refresh.value))).toBe("auth_invalid");
    await settled();
    expect(here.admits(minted.session.access.value)).toBeUndefined();
    expect(next.admits(minted.session.access.value)).toBeUndefined();
  });
});

describe("the access token is the family's, shared by the person's pages (§2.4)", () => {
  test("rotation keeps the standing access token until it is half spent", async () => {
    // A clock rather than a wait: what decides this is hours of TTL.
    let now = 1_000_000;
    const { auth } = unit({ now: () => now });
    await auth.grant(TEST_USER, [SELF], { kind: "instance", instance: SELF });
    const minted = await auth.mint(TEST_USER, ORIGIN);

    // Two loads in a row, as two tabs would do: the refresh cookie turns over
    // each time, the token the open pages hold does not.
    now += PREVIOUS_GRACE_MS + 1;
    const one = await auth.refreshToken(minted.refresh.value);
    now += PREVIOUS_GRACE_MS + 1;
    const two = await auth.refreshToken(one.refresh.value);
    expect(one.session.access.value).toBe(minted.session.access.value);
    expect(two.session.access.value).toBe(minted.session.access.value);
    expect(two.refresh.value).not.toBe(one.refresh.value);
    expect(auth.admits(minted.session.access.value)?.user).toBe(TEST_USER);

    // Past the threshold the family mints, and the pages renew together.
    now += ACCESS_TTL_MS - ACCESS_KEEP_MS;
    const three = await auth.refreshToken(two.refresh.value);
    expect(three.session.access.value).not.toBe(minted.session.access.value);
    expect(three.session.access.expires_at).toBe(now + ACCESS_TTL_MS);
    expect(auth.admits(minted.session.access.value)).toBeUndefined();
  });
});

describe("a token reused after its grace fails the family (contract, DR-0030 §5)", () => {
  test("what the family remembers outlives the instance that rotated it", async () => {
    // The digests travel with the family, so an instance that restarts — or a
    // peer the reused value is presented to — still recognises it (M4).
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-retired-"));
    let now = 1_000_000;
    const before = unit({ dir, now: () => now }).auth;
    await before.grant(TEST_USER, [SELF], { kind: "instance", instance: SELF });
    const zero = (await before.mint(TEST_USER, ORIGIN)).refresh.value;
    now += PREVIOUS_GRACE_MS + 1;
    const one = await before.refreshToken(zero);
    now += PREVIOUS_GRACE_MS + 1;
    const two = await before.refreshToken(one.refresh.value);
    const [family] = unit({ dir, now: () => now }).records.families();
    expect((family?.body.retired ?? []).length).toBe(2);

    // A fresh domain over the same records: nothing of the rotation is left in
    // memory, and the value from two generations back is still recognised.
    const after = unit({ dir, now: () => now }).auth;
    expect(after.admits(two.session.access.value)?.user).toBe(TEST_USER);
    expect(await refusal(after.refreshToken(zero))).toBe("auth_invalid");
    expect(after.admits(two.session.access.value)).toBeUndefined();
  });

  test("the generation the family still remembers is what reuse is caught by", async () => {
    // Against the domain rather than a listener, because what decides this is a
    // clock: the grace on the previous generation is a minute, and a test that
    // waited it out would be a test about waiting.
    let now = 1_000_000;
    const { auth } = unit({ now: () => now });
    await auth.grant(TEST_USER, [SELF], { kind: "instance", instance: SELF });
    const zero = (await auth.mint(TEST_USER, ORIGIN)).refresh.value;
    const one = await auth.refreshToken(zero);

    // Inside the grace it is the retry it looks like, answered with the pair
    // the caller missed.
    expect((await auth.refreshToken(zero)).refresh.value).toBe(one.refresh.value);

    now += PREVIOUS_GRACE_MS + 1;
    expect(await refusal(auth.refreshToken(zero))).toBe("auth_invalid");
    // The family went with it, so the value that was standing is gone too.
    expect(auth.admits(one.session.access.value)).toBeUndefined();
  });
});

describe("the cookie is named for the person (contract, DR-0030 §5)", () => {
  test("the cookie one instance set is the one the next instance reads, whichever of them the browser reached", async () => {
    const { peers, settled } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    await knownAt(here, ORIGIN);
    await here.grant(TEST_USER, [next.self], { kind: "instance", instance: here.self });
    const minted = await here.mint(TEST_USER, ORIGIN);
    await settled();

    const refreshAt = async (auth: Auth, cookie: string): Promise<Response | undefined> =>
      await handleAuth(
        new Request(`${auth.endpoint() as string}auth/refresh`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "sec-fetch-site": "same-site",
            cookie,
          },
          body: "{}",
        }),
        { auth, self: auth.self },
      );
    const name = cookieName(TEST_USER);
    // Nothing of an instance is in the name, so a name a browser holds is the
    // same at every instance the person owns; the digest keeps the id itself
    // out of a header.
    expect(name).not.toContain(SELF);
    expect(name).not.toContain(TEST_USER);
    expect(name).toMatch(/^__Secure-ccmsg-[0-9a-f]{16}$/);
    // Two people at one browser are told apart by it.
    expect(cookieName(OTHER_USER)).not.toBe(name);

    const one = await refreshAt(next, `${name}=${minted.refresh.value}`);
    expect(one?.status).toBe(200);
    expect(one?.headers.get("set-cookie")?.startsWith(`${name}=`)).toBe(true);
    await settled();
    const two = await refreshAt(here, mintedCookie(one as Response, name));
    expect(two?.status).toBe(200);
    expect(two?.headers.get("set-cookie")?.startsWith(`${name}=`)).toBe(true);
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

  test("a ceremony held at another origin than the passkey's is refused", async () => {
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
      // is what §2.2 asks of an enrolment URL.
      const issued = await at.instance.auth.issue({
        purpose: "create_user",
        endpoint: servedAt(at),
      });
      const challenge = (await (await post(at, "challenge", {})).json()) as { challenge: string };
      const client = Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: challenge.challenge,
          origin: at.origin,
        }),
      ).toString("base64url");
      const response = await post(at, "register", {
        token: tokenOf(issued.url),
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
    const response = await post(at, "register", { token: "x" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_args",
    );
  });

  test("an op that decides an identity is refused without either header", async () => {
    // Both are written by the browser and neither can be by a page's script, so
    // a caller stating nothing has not passed the gate rather than been let
    // past it (contract, DR-0028).
    const at = await serving();
    const issued = await at.instance.auth.issue({ purpose: "create_user", endpoint: servedAt(at) });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const challenge = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const body = {
      token: tokenOf(issued.url),
      code: issued.code,
      credential: await authenticator.create({
        challenge: challenge.challenge,
        origin: at.origin,
        userId: issued.user,
      }),
    };
    // Refused the way every binding here refuses, and saying no more than that:
    // what a caller learns from "it was the `Origin`" is which value to try
    // next (contract, DR-0030 §9).
    const refusedFor = async (answer: Response): Promise<string> => {
      expect(answer.status).toBe(401);
      return ((await answer.json()) as { error: { code: string } }).error.code;
    };
    const noOrigin = await fetch(`http://${at.instance.http[0] as string}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
    });
    expect(await refusedFor(noOrigin)).toBe("auth_invalid");
    expect(await refusedFor(await post(at, "register", body, { site: null }))).toBe("auth_invalid");
    // `none` is a request with no initiator — what a person typing an address
    // produces — which is not how any of these is reached. So is a value the
    // specification does not define: what passes is named, rather than what
    // does not.
    for (const site of ["none", "same-domain", "", "SAME-ORIGIN"]) {
      expect(await refusedFor(await post(at, "register", body, { site }))).toBe("auth_invalid");
    }
    // The three relations a page's own fetch can have to where it went are what
    // passes. Asked with a body the op's schema refuses, so that what is
    // observed is the gate letting the request through rather than a
    // registration being spent.
    for (const site of ["same-origin", "same-site", "cross-site"]) {
      const answer = await post(at, "register", {}, { site });
      expect(answer.status).toBe(400);
      expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
        "invalid_args",
      );
    }
    // The same body, with what a browser would have written, is taken.
    expect((await post(at, "register", body)).status).toBe(200);
  });

  test("a challenge is not held to those headers, and answers any page", async () => {
    // It is asked before there is anything to compare a caller with, and what it
    // hands out can only be spent by its issuer against one of the checked ops.
    const at = await serving();
    const bare = await fetch(`http://${at.instance.http[0] as string}/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(bare.status).toBe(200);
    const elsewhere = await fetch(`http://${at.instance.http[0] as string}/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://elsewhere.example" },
      body: "{}",
    });
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.headers.get("access-control-allow-origin")).toBe("http://elsewhere.example");
  });

  test("a browser that writes crossOrigin: false is admitted", async () => {
    // Chromium writes the field on every message. Reading its presence as a
    // refusal would turn away every credential those browsers make (C1).
    const at = await serving();
    const issued = await at.instance.auth.issue({ purpose: "create_user", endpoint: servedAt(at) });
    const authenticator = new SoftAuthenticator(issued.rp_id, { crossOrigin: false });
    const challenge = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const response = await post(at, "register", {
      token: tokenOf(issued.url),
      code: issued.code,
      credential: await authenticator.create({
        challenge: challenge.challenge,
        origin: at.origin,
        userId: issued.user,
      }),
    });
    expect(response.status).toBe(200);
  });

  test("an enrolment URL naming an issuer nothing can reach is refused", async () => {
    // Only the issuer can check the URL (§2.6). An issuer no entry of the mesh
    // names is one nothing can carry the question to, so it is refused — and
    // nothing is spent: the real URL still works afterwards.
    const at = await serving();
    const issued = await at.instance.auth.issue({ purpose: "create_user", endpoint: servedAt(at) });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const token = tokenOf(issued.url);
    const [header, body, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(body as string, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const elsewhere = `${header ?? ""}.${Buffer.from(
      JSON.stringify({ ...claims, iss: OTHER_INSTANCE }),
    ).toString("base64url")}.${signature ?? ""}`;

    const first = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const refused = await post(at, "register", {
      token: elsewhere,
      code: issued.code,
      credential: await authenticator.create({
        challenge: first.challenge,
        origin: at.origin,
        userId: issued.user,
      }),
    });
    // The mesh is what would have carried it, so the mesh is what answers: an
    // id it does not name is an instance it cannot reach.
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "instance_unreachable",
    );

    // Neither the URL nor one of its five tries was spent.
    const second = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const ok = await post(at, "register", {
      token,
      code: issued.code,
      credential: await authenticator.create({
        challenge: second.challenge,
        origin: at.origin,
        userId: issued.user,
      }),
    });
    expect(ok.status).toBe(200);
  });
});

describe("the enrolment URL runs out (§2.2)", () => {
  test("five wrong codes spend the URL, and so does the expiry", async () => {
    let now = 1_000_000;
    const { auth } = unit({ endpoint: ENDPOINT, now: () => now });
    const issued = await auth.issue({ purpose: "create_user" });
    const token = tokenOf(issued.url);
    const wrong = issued.code === "000000" ? "111111" : "000000";
    // Four tries are refusals of the code; the fifth spends the URL itself, so
    // guessing costs the enrolment rather than one attempt.
    for (let i = 0; i < 4; i += 1) {
      expect(() => auth.resolveEnrolment(token, wrong)).toThrow(/コードが違います/);
    }
    expect(() => auth.resolveEnrolment(token, wrong)).toThrow(/再発行/);
    expect(() => auth.resolveEnrolment(token, issued.code)).toThrow(/再発行/);

    // A fresh URL, left until its expiry, is gone the same way.
    const second = await auth.issue({ purpose: "create_user" });
    const later = tokenOf(second.url);
    now = second.expires_at + 1;
    expect(() => auth.resolveEnrolment(later, second.code)).toThrow(/期限切れ|再発行/);
  });

  test("a person's id is sixteen bytes the issuer settles, and a URL for somebody who exists carries theirs", async () => {
    const { auth } = unit({ endpoint: ENDPOINT });
    const first = await auth.issue({ purpose: "create_user" });
    const second = await auth.issue({ purpose: "create_user" });
    // The one spelling the contract has for a person: what keys their records
    // and what the authenticator hands back (contract, `UserId`).
    expect(first.user).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
    expect(second.user).not.toBe(first.user);
    // Named, the URL is a passkey for that person and settles nothing new.
    expect((await auth.issue({ purpose: "create_user", user: first.user })).user).toBe(first.user);
    // An addition names nobody: who arrives is what the assertion says.
    expect((await auth.issue({ purpose: "add_owner" })).user).toBeUndefined();
  });
});

describe("extending a connection (§2.5)", () => {
  test("a token of one's own extends it, and somebody else's does not", async () => {
    const at = await serving();
    const { auth } = at.instance;
    const mine = await personSession(auth, at.instance, TEST_USER);
    const theirs = await personSession(auth, at.instance, OTHER_USER);
    const client = await connectWs(at.instance.http[0] ?? "", mine.access.value);
    clients.push(client);
    client.send({ op: "hello.user", request_id: "1", protocol_version: PROTOCOL_VERSION });
    const greeting = (await client.next()) as { auth_expires_at: number };

    client.send({ op: "auth.extend", request_id: "2", access_token: theirs.access.value });
    expect(await client.next()).toMatchObject({
      ok: false,
      request_id: "2",
      error: { code: "auth_invalid" },
    });

    const [family] = auth.records.families().filter(({ body }) => body.user === TEST_USER);
    const next = await auth.refreshToken(family?.body.refresh.value ?? "");
    client.send({
      op: "auth.extend",
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
    const minted = await personSession(at.instance.auth, at.instance);
    // Almost the whole life of the token has passed by the time the handshake
    // happens, so the connection is held with a deadline moments away.
    now = minted.access.expires_at - 60;

    const client = await connectWs(at.instance.http[0] ?? "", minted.access.value);
    client.send({ op: "hello.user", request_id: "1", protocol_version: PROTOCOL_VERSION });
    const greeting = (await client.next()) as { auth_expires_at: number };
    expect(greeting.auth_expires_at).toBe(minted.access.expires_at);

    now = minted.access.expires_at + 1;
    await client.whenClosed;
    expect(at.instance.auth.heldCounts.connections).toBe(0);
  });
});

describe("what a peer's records may and may not do (contract, DR-0030 §3, §5)", () => {
  test("a failed family is not revived, a removal travels, and nothing brings a removed key back", async () => {
    const { auth, records } = unit();
    await auth.grant(TEST_USER, [SELF], { kind: "instance", instance: SELF });
    const minted = await auth.mint(TEST_USER, ORIGIN);
    const [family] = records.families();
    await records.fail(family?.key ?? "");
    expect(auth.admits(minted.session.access.value)).toBeUndefined();

    // The copy a peer still holds is older news about a family that was
    // failed, and taking it would undo the failure (M2).
    expect(
      (
        await records.merge([
          { key: family?.key ?? "", updated_at: Date.now() + 60_000, body: family?.body as never },
        ])
      ).changed,
    ).toBe(0);
    expect(auth.admits(minted.session.access.value)).toBeUndefined();

    // A removal that arrived from a peer refuses the credential here too, and
    // says whose it was.
    const gone: CredentialRecord = {
      kind: "credential",
      user: OTHER_USER,
      credential_id: "abc",
      public_key: "k",
      origin: ORIGIN,
      registered_at: 1,
    };
    await records.write("credential/abc", gone);
    // Stated as later than the write: the last write wins, and an equal
    // instant is not later.
    const later = Date.now() + 1_000;
    const removal = await records.merge([
      {
        key: "credential/abc",
        updated_at: later,
        body: { kind: "tombstone", deleted_at: later },
      },
    ]);
    expect(removal.revoked).toEqual([OTHER_USER]);
    expect(records.credentials()).toEqual([]);
    // And nothing brings it back.
    expect(
      (
        await records.merge([
          { key: "credential/abc", updated_at: Date.now() + 60_000, body: gone },
        ])
      ).changed,
    ).toBe(0);
    expect(records.credentials()).toEqual([]);
  });

  test("a record outside the contract's shape is not taken, from a peer or from the file", async () => {
    // What a peer says and what a file from before this contract's generation
    // holds go through one gate. A body shaped otherwise names nothing this
    // instance can act on, and the contract has no migration: the person
    // registers again (contract, DR-0030, 移行).
    const now = Date.now();
    const foreign: { name: string; record: unknown }[] = [
      {
        name: "a credential bound to an endpoint and a web UI",
        record: {
          key: "credential/old/abc",
          updated_at: now,
          body: {
            kind: "credential",
            sub: "old-1",
            credential_id: "abc",
            public_key: "k",
            user_handle: "u",
            endpoint: ENDPOINT,
            webui: ENDPOINT,
            registered_at: 1,
          },
        },
      },
      {
        name: "a family of a subject",
        record: {
          key: "family/old/1",
          updated_at: now,
          body: {
            kind: "token_family",
            sub: "old-1",
            iss: SELF,
            webui: ENDPOINT,
            access: { value: "access-of-the-old-one", expires_at: now + 3_600_000 },
            refresh: { value: "refresh-of-the-old-one", expires_at: now + 86_400_000 },
          },
        },
      },
      {
        name: "a person whose id is not sixteen bytes",
        record: {
          key: "user/someone",
          updated_at: now,
          body: { kind: "user", user: "someone", created_at: now },
        },
      },
      {
        name: "a granting with no id of its own",
        record: {
          key: `ownership/${SELF}/${TEST_USER}`,
          updated_at: now,
          body: { kind: "ownership", user: TEST_USER, instance: SELF, granted_at: now },
        },
      },
      {
        name: "a credential at an origin with a path",
        record: {
          key: "credential/pathed",
          updated_at: now,
          body: {
            kind: "credential",
            user: TEST_USER,
            credential_id: "pathed",
            public_key: "k",
            origin: "https://ui.example/personal/",
            registered_at: 1,
          },
        },
      },
    ];
    const { auth, records } = unit({ endpoint: ENDPOINT });
    for (const { name, record } of foreign) {
      expect([name, (await records.merge([record as AuthRecord])).changed]).toEqual([name, 0]);
    }
    expect(records.all()).toEqual([]);
    expect(auth.admits("access-of-the-old-one")).toBeUndefined();
    expect(await refusal(auth.refreshToken("refresh-of-the-old-one"))).toBe("auth_invalid");

    // The file the previous generation left behind, read on start: nothing of
    // it is kept, and the first write leaves a file of the contract's shape.
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-old-file-"));
    writeFileSync(join(dir, "records.json"), JSON.stringify(foreign.map(({ record }) => record)));
    const fresh = unit({ dir, endpoint: ENDPOINT });
    expect(fresh.records.all()).toEqual([]);
    expect(fresh.auth.knownOrigins()).toEqual([]);

    // This instance's own write is held to the same shape, as a fault rather
    // than a quiet drop: it is the one place that can say why.
    const fault = await fresh.records
      .write("credential/mine", {
        kind: "credential",
        user: "someone",
        credential_id: "mine",
        public_key: "k",
        origin: ORIGIN,
        registered_at: 1,
      } as never)
      .then(
        () => "written",
        (cause: unknown) => String(cause),
      );
    expect(fault).toMatch(/contract's shape/);
    expect(fresh.records.all()).toEqual([]);
  });
});

describe("the user handle a person is known by (contract, DR-0030 §1)", () => {
  test("the record keeps what the registration settled, and an assertion is held to it", async () => {
    const at = await serving();
    const { user, authenticator } = await registered(at);
    // The id is the handle: one value keys the records and is what the
    // authenticator was given.
    expect(authenticator.userHandle).toBe(user);
    expect(at.instance.auth.records.credentials()[0]?.user).toBe(user);

    // The resident credential answers with that handle, and is admitted.
    expect((await asserting(at, authenticator)).status).toBe(200);

    // One naming somebody else is an authenticator answering for a credential
    // this record does not describe.
    authenticator.userHandle = OTHER_USER;
    const refused = await asserting(at, authenticator);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("auth_invalid");
  });
});

describe("where the enrolment URL points (contract, DR-0030 §4)", () => {
  test("the URL a command issues is the origin's root, with the token in its fragment", async () => {
    const { auth } = unit({ endpoint: "https://h.example/personal/" });
    const issued = await auth.issue({ purpose: "create_user" });
    // The person is sent to the root of the origin: a path under it is nothing
    // a browser writes into an `Origin` or a `clientDataJSON`, so there is
    // nothing under it to name (contract, `EnrollClaims.origin`).
    expect(issued.url.startsWith("https://h.example/#enroll=")).toBe(true);
    expect(issued.origin).toBe("https://h.example");
    expect(issued.rp_id).toBe("h.example");
    // The endpoint is where the page posts, and stays what it was: an instance
    // serving its own UI is the ordinary case.
    expect(issued.endpoint).toBe("https://h.example/personal/");
    expect(issued.instance).toBe(SELF);
  });

  test("a page published elsewhere is where the URL sends the person, and the endpoint is a destination", async () => {
    const { auth } = unit({ endpoint: "https://mba.example.ts.net/ccmsg/personal/" });
    const issued = await auth.issue({
      purpose: "create_user",
      origin: "https://ui.example.test",
    });
    // Where the person goes is the page; where the page posts is the endpoint.
    // Neither is derived from the other, and the receiver compares the second
    // with nothing (contract, `EnrollClaims.endpoint`).
    expect(issued.url.startsWith("https://ui.example.test/#enroll=")).toBe(true);
    expect(issued.endpoint).toBe("https://mba.example.ts.net/ccmsg/personal/");
    expect(issued.rp_id).toBe("ui.example.test");
    // A load balancer's address, behind which any instance completes it.
    const balanced = await auth.issue({
      purpose: "create_user",
      origin: "https://ui.example.test",
      endpoint: "https://ccmsg2.example.test/",
    });
    expect(balanced.endpoint).toBe("https://ccmsg2.example.test/");
  });

  test("an endpoint or an origin not spelled as the contract spells it is refused where it is typed", async () => {
    // An operator types these. A value that is not what the contract spells
    // would be written into a record and compared forever after against
    // something that can never match it.
    const { auth } = unit({ endpoint: undefined });
    const issuing = async (options: {
      origin?: string;
      endpoint?: string;
    }): Promise<string | undefined> =>
      await refusal(
        auth.issue({
          purpose: "create_user",
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        }),
      );
    // An instance with no endpoint of its own has nowhere to send the page's
    // answer, and the operator names one.
    expect(await issuing({})).toBe("invalid_args");
    for (const endpoint of [
      "https://h.example/ws",
      "wss://h.example/personal/ws",
      "https://h.example",
    ]) {
      expect([endpoint, await issuing({ endpoint })]).toEqual([endpoint, "invalid_args"]);
    }
    // An origin has no path and no trailing slash, and is somewhere a ceremony
    // could be held: `https` anywhere, `http` on the loopback names, and never
    // an address literal (contract, `Origin`).
    for (const origin of [
      "https://ui.example/",
      "https://ui.example/ccmsg",
      "http://example.com",
      "https://198.51.100.9",
      "https://[2001:db8::1]",
      "https://UI.example",
    ]) {
      expect([origin, await issuing({ endpoint: "https://h.example/", origin })]).toEqual([
        origin,
        "invalid_args",
      ]);
    }
    for (const origin of [
      "https://ui.example.test",
      "http://localhost:3000",
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
    ]) {
      expect(
        (await auth.issue({ purpose: "create_user", endpoint: "https://h.example/", origin }))
          .origin,
      ).toBe(origin);
    }
    // An endpoint no ceremony could run at is an address like any other, and
    // is not an origin to fall back on: the operator names the page.
    expect(await issuing({ endpoint: "https://198.51.100.9/" })).toBe("invalid_args");
    expect(
      (
        await auth.issue({
          purpose: "create_user",
          endpoint: "https://198.51.100.9/",
          origin: "https://ui.example.test",
        })
      ).endpoint,
    ).toBe("https://198.51.100.9/");
  });
});

describe("a credential is good from one origin (contract, DR-0030 §2)", () => {
  test("a page at another origin is refused, whatever it holds", async () => {
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
    // Another owner made a passkey at another page, so that page is one this
    // instance answers CORS for. The record names the page this credential was
    // made at, and the browser's own word for where this request came from is
    // held to it: a page elsewhere is refused before the signature is looked
    // at, however good its standing with the instance.
    await knownAt(at.instance.auth, "https://ui.example", OTHER_USER);
    const elsewhere = await post(
      at,
      "assert",
      { credential, challenge },
      { origin: "https://ui.example" },
    );
    expect(elsewhere.status).toBe(401);
    expect(((await elsewhere.json()) as { error: { code: string } }).error.code).toBe(
      "auth_invalid",
    );
    // The same assertion from the page it was made at is taken.
    expect((await post(at, "assert", { credential, challenge })).status).toBe(200);
  });

  test("a handshake from another page does not open a connection", async () => {
    const at = await serving();
    const minted = await personSession(at.instance.auth, at.instance);
    const address = at.instance.http[0] ?? "";
    // Refused as an upgrade that does not happen: there is no connection yet to
    // answer an error frame on.
    const elsewhere = await connectWs(address, minted.access.value, {
      origin: "http://elsewhere.example",
    }).then(
      async (opened) => {
        await opened.close();
        return "opened";
      },
      () => "refused",
    );
    expect(elsewhere).toBe("refused");
    const client = await connectWs(address, minted.access.value);
    clients.push(client);
    client.send({ op: "hello.user", request_id: "1", protocol_version: PROTOCOL_VERSION });
    expect(await client.next()).toMatchObject({ ok: true });
  });

  test("the refresh cookie is partitioned where the page is at another site", async () => {
    // Which site the page belongs to is what decides it, and nothing else: the
    // same endpoint answers every one of these people (DR-0028). A site is a
    // scheme and a registrable domain, read off the same public suffix list the
    // browser reads — including its private section, which is what makes two
    // hosts under one of those suffixes two sites.
    const { auth } = unit({ endpoint: "https://mba.example.net/" });
    const cookieFor = async (origin: string, user: UserId): Promise<string> => {
      // The instance answers for a page one of its owners made a passkey at.
      await knownAt(auth, origin, user);
      const minted = await auth.mint(user, origin);
      const name = cookieName(user);
      const answer = await handleAuth(
        new Request("https://mba.example.net/auth/refresh", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            "sec-fetch-site": "same-origin",
            cookie: `${name}=${minted.refresh.value}`,
          },
          body: "{}",
        }),
        { auth, self: SELF },
      );
      expect(answer?.status).toBe(200);
      return answer?.headers.get("set-cookie") ?? "";
    };

    const strict = async (origin: string, user: UserId): Promise<boolean> => {
      const cookie = await cookieFor(origin, user);
      // Whichever it is, it is the browser's to keep and nobody's to read.
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      if (cookie.includes("SameSite=Strict")) {
        expect(cookie).not.toContain("Partitioned");
        return true;
      }
      expect(cookie).toContain("SameSite=None");
      expect(cookie).toContain("Partitioned");
      return false;
    };

    // The endpoint's own page, and another host under the same registrable
    // domain: one site, so the cookie is not partitioned.
    expect(await strict("https://mba.example.net", person(1))).toBe(true);
    expect(await strict("https://ui.example.net", person(2))).toBe(true);
    // Another registrable domain is another site.
    expect(await strict("https://example.org", person(3))).toBe(false);
    // And so is a host under a public suffix that is not this endpoint's: the
    // list's private section is what says `a.github.io` and `b.github.io` are
    // two sites rather than two hosts of one.
    expect(await strict("https://a.github.io", person(4))).toBe(false);
  });

  test("two hosts under one public suffix are two sites to the cookie as well", async () => {
    const { auth } = unit({ endpoint: "https://b.github.io/" });
    await knownAt(auth, "https://a.github.io");
    const minted = await auth.mint(TEST_USER, "https://a.github.io");
    const name = cookieName(TEST_USER);
    const answer = await handleAuth(
      new Request("https://b.github.io/auth/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://a.github.io",
          "sec-fetch-site": "cross-site",
          cookie: `${name}=${minted.refresh.value}`,
        },
        body: "{}",
      }),
      { auth, self: SELF },
    );
    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("set-cookie")).toContain("Partitioned");
  });

  test("the relying party the ceremony is held to is the origin's host, not the endpoint's", async () => {
    // The two are different hosts here, which is the whole point of naming the
    // origin: a credential made under the endpoint's host would be one the
    // authenticator answers for at the endpoint's site as well.
    const { auth } = unit({ endpoint: "https://mba.example.test/" });
    const register = async (rpId: string): Promise<string | undefined> => {
      const issued = await auth.issue({
        purpose: "create_user",
        origin: "https://ui.example.test",
      });
      const authenticator = new SoftAuthenticator(rpId);
      const challenge = await auth.challenge();
      return await refusal(
        auth.register({
          token: tokenOf(issued.url),
          code: issued.code,
          credential: await authenticator.create({
            challenge: challenge.challenge,
            // The page is the same either way; what differs is the relying
            // party the authenticator signed under.
            origin: "https://ui.example.test",
            userId: issued.user,
          }),
        }),
      );
    };
    expect(await register("mba.example.test")).toBe("auth_invalid");
    expect(await register("ui.example.test")).toBeUndefined();
  });

  test("a registration and a refresh are held to the page as an assertion is", async () => {
    const { auth } = unit({ endpoint: "https://h.example/" });
    const issued = await auth.issue({ purpose: "create_user" });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const challenge = await auth.challenge();
    const credential = await authenticator.create({
      challenge: challenge.challenge,
      origin: "https://h.example",
      userId: issued.user,
    });
    const token = tokenOf(issued.url);
    // A page elsewhere, holding everything else that is right.
    expect(
      await refusal(
        auth.register(
          { token, code: issued.code, credential },
          { origin: "https://elsewhere.example" },
        ),
      ),
    ).toBe("auth_invalid");
    expect(
      await refusal(auth.register({ token, code: issued.code, credential }, { origin: null })),
    ).toBe("auth_invalid");
    const minted = await auth.register({ token, code: issued.code, credential });

    // And the same of a refresh, which is checked before the family is
    // rotated.
    expect(
      await refusal(
        auth.refreshToken(minted.refresh.value, { origin: "https://elsewhere.example" }),
      ),
    ).toBe("auth_invalid");
    expect(await refusal(auth.refreshToken(minted.refresh.value, { origin: null }))).toBe(
      "auth_invalid",
    );
    expect(
      await refusal(auth.refreshToken(minted.refresh.value, { origin: "https://h.example" })),
    ).toBeUndefined();
  });
});

describe("the two headers every route that decides an identity is held to (contract, DR-0030 §9)", () => {
  test("register, enroll, assert, refresh and signout each refuse a page that states no origin, another page's, or a fetch site outside the three", async () => {
    // Laid out route by route rather than shown on one of them: the gate is
    // one piece of code in the carrier, and what could be wrong is a route
    // that reaches the op without passing it, which only the row for that
    // route would catch.
    const at = await serving();
    const { user, authenticator, response } = await registered(at);
    // A page an owner made a passkey at, so a request from it reaches the op:
    // what is observed is the op holding the header to its own origin, and not
    // the preflight set turning the page away before that.
    const elsewhere = "https://ui.example";
    await knownAt(at.instance.auth, elsewhere, OTHER_USER);

    // One body each route takes, made once. Nothing a refusal reaches spends
    // the URL, the challenge or the cookie, so the same body answered with the
    // headers a browser would have written is what shows the body was good
    // and the headers were what refused it.
    const challenge = async () =>
      (await (await post(at, "challenge", {})).json()) as {
        challenge: string;
        issuer: string;
        expires_at: number;
      };
    const newcomer = await at.instance.auth.issue({
      purpose: "create_user",
      endpoint: servedAt(at),
    });
    const first = await challenge();
    const register = {
      token: tokenOf(newcomer.url),
      code: newcomer.code,
      credential: await new SoftAuthenticator(newcomer.rp_id).create({
        challenge: first.challenge,
        origin: at.origin,
        userId: newcomer.user,
      }),
    };
    const adding = await at.instance.auth.issue({ purpose: "add_owner", endpoint: servedAt(at) });
    const second = await challenge();
    const enroll = {
      token: tokenOf(adding.url),
      code: adding.code,
      challenge: second,
      credential: await authenticator.get({ challenge: second.challenge, origin: at.origin }),
    };
    const third = await challenge();
    const assert = {
      challenge: third,
      credential: await authenticator.get({ challenge: third.challenge, origin: at.origin }),
    };
    const cookie = mintedCookie(response, cookieName(user));

    // `signout` is last, its own answer being the end of the family the rest
    // of the rows are driven with.
    const bodies: Record<string, unknown> = { register, enroll, assert, refresh: {}, signout: {} };
    const gates: [string, { origin?: string | null; site?: string | null }][] = [
      ["no Origin", { origin: null }],
      ["the Origin of another page", { origin: elsewhere }],
      ["no Sec-Fetch-Site", { site: null }],
      ["Sec-Fetch-Site: none", { site: "none" }],
      ["a Sec-Fetch-Site outside the specification", { site: "same-domain" }],
    ];
    for (const [route, body] of Object.entries(bodies)) {
      for (const [gate, init] of gates) {
        const answer = await post(at, route, body, { cookie, ...init });
        const code = ((await answer.json()) as { error?: { code?: string } }).error?.code;
        // The one answer every gate gives, saying that the exchange was
        // refused and not which header refused it.
        expect([route, gate, answer.status, code]).toEqual([route, gate, 401, "auth_invalid"]);
      }
      expect([route, (await post(at, route, body, { cookie })).status]).toEqual([route, 200]);
    }

    // `auth.challenge` is not among them: it is asked before there is anything
    // to compare a caller with, and what it hands out is spendable only at its
    // issuer against one of the four.
    expect((await post(at, "challenge", {}, { origin: null, site: "none" })).status).toBe(200);
  });

  test("an enrolment holds the Origin to the URL's page, and the ceremony to the passkey's", async () => {
    // The two columns are different for this one op (contract, DR-0030 §9):
    // the URL sends the person to the instance's own page, and the passkey they
    // answer with lives at the page it was made at, which may be another.
    const { peers, settled } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    const { user, authenticator } = await registeredAt(here);
    await settled();
    expect(next.records.owns(user, next.self)).toBe(false);
    // The second instance's page is one it answers CORS for once somebody has
    // a passkey there; the person enrolling is not that somebody.
    await knownAt(next, "https://next.example", OTHER_USER);

    const issued = await next.issue({ purpose: "add_owner" });
    expect(issued.origin).toBe("https://next.example");
    const challenge = await next.challenge();
    const body = JSON.stringify({
      token: tokenOf(issued.url),
      code: issued.code,
      challenge,
      // Signed at the page the passkey was made at, which is the first
      // instance's and not the page the URL sent the person to.
      credential: await authenticator.get({ challenge: challenge.challenge, origin: ORIGIN }),
    });
    const enroll = async (origin: string): Promise<Response> =>
      (await handleAuth(
        new Request("https://next.example/auth/enroll", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            "sec-fetch-site": "same-origin",
          },
          body,
        }),
        { auth: next, self: OTHER_INSTANCE },
      )) as Response;

    // The page the passkey lives at is not the page the URL is for, however
    // much the ceremony agrees with it — and nothing is spent by the refusal.
    const fromThePasskeysPage = await enroll(ORIGIN);
    expect(fromThePasskeysPage.status).toBe(401);
    expect(((await fromThePasskeysPage.json()) as { error: { code: string } }).error.code).toBe(
      "auth_invalid",
    );
    expect(next.records.owns(user, next.self)).toBe(false);

    // From the page the URL sent the person to, with the same assertion signed
    // at the passkey's own page, the instance is theirs.
    const fromTheUrlsPage = await enroll("https://next.example");
    expect(fromTheUrlsPage.status).toBe(200);
    expect(((await fromTheUrlsPage.json()) as { user: string }).user).toBe(user);
    expect(next.records.owns(user, next.self)).toBe(true);
    expect(next.records.grantsOf(user, next.self)[0]?.body.granted_by).toEqual({
      kind: "instance",
      instance: next.self,
    });
  });
});

describe("reading and pruning one's own account (contract, DR-0030 §3, §8)", () => {
  test("the account is the person, their passkeys without keys, and their instances", async () => {
    const at = await serving();
    const { user, authenticator } = await registered(at);
    await registered(at, { user });
    await at.instance.auth.grant(user, [OTHER_INSTANCE], { kind: "user", user });
    const session = (await (await asserting(at, authenticator)).json()) as {
      access: { value: string };
    };
    const client = await connected(at, session.access.value);

    client.send({ op: "auth.account.read", request_id: "reading" });
    const answer = (await client.next()) as { ok: boolean } & AuthAccountReadResult;
    expect(answer.ok).toBe(true);
    expect(answer.user).toMatchObject({ kind: "user", user });
    expect(answer.credentials).toHaveLength(2);
    for (const line of answer.credentials) {
      expect(line.user).toBe(user);
      expect("public_key" in line).toBe(false);
    }
    expect(answer.instances.map((row) => row.instance)).toEqual([at.instance.self, OTHER_INSTANCE]);
    expect(answer.instances[0]?.granted_by).toEqual({
      kind: "instance",
      instance: at.instance.self,
    });
    expect(answer.instances[1]?.granted_by).toEqual({ kind: "user", user });
  });

  test("the instance underfoot and the passkey in hand are refused as in use; the rest is let go", async () => {
    const at = await serving();
    const { user, authenticator } = await registered(at);
    const other = await registered(at, { user });
    await at.instance.auth.grant(user, [OTHER_INSTANCE], { kind: "user", user });
    const session = (await (await asserting(at, authenticator)).json()) as {
      access: { value: string };
    };
    const client = await connected(at, session.access.value);
    const ask = async (
      request_id: string,
      frame: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      client.send({ ...frame, request_id });
      return (await client.next()) as Record<string, unknown>;
    };

    // A person removing their own footing would be cutting the call they are
    // making, and one removing the key they hold would be locking themselves
    // out mid-sentence: both are theirs to remove, from somewhere else.
    expect(
      await ask("underfoot", { op: "auth.ownership.remove", instance: at.instance.self }),
    ).toMatchObject({ ok: false, error: { code: "auth_in_use" } });
    expect(
      await ask("in-hand", {
        op: "auth.credential.remove",
        credential_id: authenticator.credentialIdUrl,
      }),
    ).toMatchObject({ ok: false, error: { code: "auth_in_use" } });
    expect(at.instance.auth.records.owns(user, at.instance.self)).toBe(true);
    expect(at.instance.auth.records.credentials()).toHaveLength(2);

    // Another instance and another passkey go.
    expect(
      await ask("elsewhere", { op: "auth.ownership.remove", instance: OTHER_INSTANCE }),
    ).toMatchObject({ ok: true });
    expect(at.instance.auth.records.owns(user, OTHER_INSTANCE)).toBe(false);
    expect(
      await ask("spare", {
        op: "auth.credential.remove",
        credential_id: other.authenticator.credentialIdUrl,
      }),
    ).toMatchObject({ ok: true });
    expect(at.instance.auth.records.credentials()).toHaveLength(1);
    expect((await asserting(at, other.authenticator)).status).toBe(401);

    // What is not held is not found: an instance the person does not own, and
    // a passkey that is somebody else's or nobody's.
    expect(
      await ask("not-mine", { op: "auth.ownership.remove", instance: OTHER_INSTANCE }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    await knownAt(at.instance.auth, "https://theirs.example", OTHER_USER);
    const [theirs] = at.instance.auth.records
      .credentials()
      .filter((record) => record.user === OTHER_USER);
    expect(
      await ask("theirs", {
        op: "auth.credential.remove",
        credential_id: theirs?.credential_id ?? "",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(at.instance.auth.records.credential(theirs?.credential_id ?? "")).toBeDefined();
    // The connection stands through all of it.
    client.send({ op: "auth.account.read", request_id: "still-here" });
    expect(await client.next()).toMatchObject({ ok: true, request_id: "still-here" });
  });
});

describe("what the command line does to people (DR-0001 §2.2)", () => {
  test("a person is made with a URL, handed an instance without one, listed, renamed and let go", async () => {
    const at = await serving();
    const { auth } = at.instance;
    const admin = async (request: Parameters<typeof handleAdmin>[1]) => {
      const answer = await handleAdmin({ auth }, request);
      expect(answer.kind).toBe("reply");
      return (answer as { response: Record<string, unknown> }).response;
    };
    const created = await admin({
      admin: "user_create",
      request_id: "1",
      endpoint: servedAt(at),
      name: "kawaz",
      label: "for the laptop",
    });
    const user = created["user"] as UserId;
    expect(created).toMatchObject({ purpose: "create_user", instances: [at.instance.self] });
    expect(created["url"]).toContain("#enroll=");
    expect(user).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
    // Nothing is granted until the ceremony stands: a URL nobody spends leaves
    // no granting naming a person no user record answers for.
    expect(auth.records.owns(user, at.instance.self)).toBe(false);
    const authenticator = new SoftAuthenticator(created["rp_id"] as string);
    const challenge = (await (await post(at, "challenge", {})).json()) as { challenge: string };
    const made = await post(at, "register", {
      token: tokenOf(created["url"] as string),
      code: created["code"],
      credential: await authenticator.create({
        challenge: challenge.challenge,
        origin: at.origin,
        userId: user,
      }),
    });
    expect(made.status).toBe(200);
    expect(auth.records.owns(user, at.instance.self)).toBe(true);
    // What the terminal wrote about who the URL was for is on the passkey.
    expect(auth.records.credentials()[0]?.issued_label).toBe("for the laptop");

    // An instance handed over from its terminal, with no browser involved:
    // everything to be checked is already here. Named again, nothing widens.
    expect(await admin({ admin: "user_add", request_id: "2", user })).toMatchObject({
      user,
      granted: [],
    });
    // And a URL for the instance that has never heard of the person, which
    // asserts with the passkey they hold.
    const adding = await admin({
      admin: "user_add",
      request_id: "3",
      user,
      enroll: true,
      endpoint: servedAt(at),
    });
    expect(adding).toMatchObject({ purpose: "add_owner", instances: [at.instance.self] });
    expect("user" in adding).toBe(false);

    expect(
      await admin({ admin: "user_rename", request_id: "4", user, display_name: "kawaz" }),
    ).toMatchObject({ kind: "user", user, display_name: "kawaz" });
    const listed = (await admin({ admin: "user_list", request_id: "5" }))[
      "users"
    ] as AuthAccountReadResult[];
    expect(listed.map((row) => row.user)).toMatchObject([{ user, display_name: "kawaz" }]);
    expect(listed[0]?.instances.map((row) => row.instance)).toEqual([at.instance.self]);

    const removed = await admin({ admin: "user_remove", request_id: "6", user });
    expect(removed).toMatchObject({ user, released: [at.instance.self] });
    expect(auth.records.owns(user, at.instance.self)).toBe(false);
    // Nothing left to release is said so, rather than answered as done.
    const nothing = await handleAdmin({ auth }, { admin: "user_remove", request_id: "7", user });
    expect(nothing).toMatchObject({ kind: "error", response: { error: { code: "not_found" } } });
  });

  test("an instance is handed over without a URL only to somebody this instance knows", async () => {
    // A granting for a person no user record answers for would be written
    // down and carried to every peer, admitting nobody and reading like one
    // that means something (contract, DR-0030 §4). The mesh is what brings
    // the person, so the same request is refused before it arrives and
    // answered after.
    const { peers, settled } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    const add = async (at: Auth, user: UserId, all?: boolean) =>
      await handleAdmin(
        { auth: at },
        { admin: "user_add", request_id: "1", user, ...(all === undefined ? {} : { all }) },
      );

    const unknown = await add(next, TEST_USER);
    expect(unknown).toMatchObject({ kind: "error", response: { error: { code: "not_found" } } });
    // `--all` walks the peers, and finds nobody to write about at any of them.
    expect(await add(next, TEST_USER, true)).toMatchObject({
      kind: "error",
      response: { error: { code: "not_found" } },
    });
    expect(next.records.ownerships()).toEqual([]);
    await settled();
    expect(here.records.ownerships()).toEqual([]);

    // The person made at the first instance reaches the second by replication,
    // and from then on the granting is one line written where they are asked
    // for.
    const { user } = await registeredAt(here);
    await settled();
    expect(next.records.user(user)).toBeDefined();
    expect(next.records.owns(user, next.self)).toBe(false);
    expect(await add(next, user)).toMatchObject({
      kind: "reply",
      response: { user, granted: [next.self] },
    });
    expect(next.records.owns(user, next.self)).toBe(true);
    // Somebody known who already owns the instance is answered, and nothing
    // widens: the granting is held or not held.
    expect(await add(next, user)).toMatchObject({ kind: "reply", response: { user, granted: [] } });
    expect(next.records.grantsOf(user, next.self)).toHaveLength(1);
  });

  test("a passkey removed from the terminal answers nothing afterwards, and its origin leaves with it", async () => {
    const at = await serving();
    const { user, authenticator } = await registered(at);
    expect(at.instance.auth.knownOrigins()).toEqual([at.origin]);
    const answer = await handleAdmin(
      { auth: at.instance.auth },
      { admin: "passkey_remove", request_id: "1", credential_id: authenticator.credentialIdUrl },
    );
    expect(answer).toMatchObject({
      kind: "reply",
      response: { credential_id: authenticator.credentialIdUrl, user },
    });
    expect(at.instance.auth.records.credentials()).toEqual([]);
    expect(at.instance.auth.knownOrigins()).toEqual([]);
    // The person and their granting stand: what went was a key.
    expect(at.instance.auth.records.user(user)).toBeDefined();
    expect(at.instance.auth.records.owns(user, at.instance.self)).toBe(true);
    expect((await asserting(at, authenticator)).status).toBe(403);
  });
});

describe("signing out ends the family (contract, `auth.signout`)", () => {
  test("the cookie names the family, the family goes, and the reply is where the cookie is expired", async () => {
    const at = await serving();
    const { user, response } = await registered(at);
    const name = cookieName(user);
    const cookie = mintedCookie(response, name);
    const session = (await response.json()) as { access: { value: string } };
    await connected(at, session.access.value);
    expect(at.instance.auth.heldCounts.connections).toBe(1);

    const answer = await post(at, "signout", {}, { cookie });
    expect(answer.status).toBe(200);
    // Nothing in the body: what the call is for happens beside it.
    expect(await answer.json()).toEqual({});
    const header = answer.headers.get("set-cookie") ?? "";
    expect(header.startsWith(`${name}=`)).toBe(true);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    // The browser drops a cookie only where the path is the one it filed it
    // under, so this is written by the rules the minting one is.
    expect(header).toContain(`Path=${cookiePath("/auth/signout")}`);

    // The family is gone, the token it answered for opens nothing, and the
    // connection it was holding is closed.
    expect(at.instance.auth.records.families()).toEqual([]);
    expect(at.instance.auth.admits(session.access.value)).toBeUndefined();
    expect(at.instance.auth.heldCounts.connections).toBe(0);
    // The person and their passkey stand: what ended was one sign-in.
    expect(at.instance.auth.records.user(user)).toBeDefined();
    expect(at.instance.auth.records.owns(user, at.instance.self)).toBe(true);

    // The same cookie a second time names nothing any more.
    expect((await post(at, "signout", {}, { cookie })).status).toBe(401);
  });

  test("a caller with no cookie and one with a value nobody minted are refused, and nothing is written", async () => {
    const at = await serving();
    const { user, response } = await registered(at);
    const name = cookieName(user);
    const session = (await response.json()) as { access: { value: string } };

    for (const cookie of [undefined, `${name}=not-a-token-anybody-minted`]) {
      const answer = await post(at, "signout", {}, cookie === undefined ? {} : { cookie });
      expect(answer.status).toBe(401);
      expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
        "auth_invalid",
      );
      // A refusal writes nothing: the family that is standing goes on standing.
      expect(answer.headers.get("set-cookie")).toBeNull();
      expect(at.instance.auth.admits(session.access.value)?.user).toBe(user);
    }
  });

  test("a value past its own expiry still names the family it was minted for", async () => {
    // What an expired value names is the family it was minted for, and leaving
    // is what an expiry comes to anyway — so the generation in grace is
    // answered after that grace has run out, where a refresh would refuse it.
    let now = 1_000_000;
    const { auth } = unit({ now: () => now });
    await auth.grant(TEST_USER, [SELF], { kind: "instance", instance: SELF });
    const minted = await auth.mint(TEST_USER, ORIGIN);
    await auth.refreshToken(minted.refresh.value);
    now += PREVIOUS_GRACE_MS + 1;

    const ended = await auth.signout(minted.refresh.value, { origin: ORIGIN });
    expect(ended).toEqual({ user: TEST_USER, origin: ORIGIN });
    expect(auth.records.families()).toEqual([]);
    expect(auth.admits(minted.session.access.value)).toBeUndefined();
  });

  test("ownership is not asked, and the page is held to the family's origin", async () => {
    const { auth } = unit();
    await auth.grant(TEST_USER, [SELF], { kind: "instance", instance: SELF });
    const minted = await auth.mint(TEST_USER, ORIGIN);
    // A cookie standing to its expiry because the ownership was taken away
    // would be a door that cannot be closed, so leaving asks no right to enter.
    await auth.revoke(TEST_USER, SELF);
    expect(auth.records.owns(TEST_USER, SELF)).toBe(false);

    expect(
      await refusal(auth.signout(minted.refresh.value, { origin: "https://elsewhere.example" })),
    ).toBe("auth_invalid");
    expect(await refusal(auth.signout(minted.refresh.value, { origin: null }))).toBe(
      "auth_invalid",
    );
    expect(auth.records.families()).toHaveLength(1);

    await auth.signout(minted.refresh.value, { origin: ORIGIN });
    expect(auth.records.families()).toEqual([]);
  });

  test("the mark reaches the peers, and closes the connections the person holds there", async () => {
    // Signing out at whichever instance the page reached is the whole of it:
    // a connection left open on a peer would be the person signed out of
    // nothing, which is what replicating the mark is for.
    const { peers, settled } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    await knownAt(here, ORIGIN);
    await here.grant(TEST_USER, [next.self], { kind: "instance", instance: here.self });
    const minted = await here.mint(TEST_USER, ORIGIN);
    await settled();
    const conn = new TestConn();
    let closed = false;
    conn.onClose(() => {
      closed = true;
    });
    next.hold(
      conn,
      next.admits(minted.session.access.value) as { user: UserId; expiresAt: number },
    );

    // Answered at the instance that did not mint it, as a rotation is.
    await next.signout(minted.refresh.value, { origin: ORIGIN });
    await settled();

    expect(closed).toBe(true);
    expect(next.heldCounts.connections).toBe(0);
    expect(here.admits(minted.session.access.value)).toBeUndefined();
    expect(next.admits(minted.session.access.value)).toBeUndefined();
    // The person still owns both instances: what ended was the family.
    expect(here.records.owns(TEST_USER, here.self)).toBe(true);
  });
});

describe("a registration URL is checked before a form is shown (contract, DR-0030 §4)", () => {
  test("a URL that could still be spent answers a challenge, and is not spent by the asking", async () => {
    const { auth } = unit({ endpoint: ENDPOINT });
    const issued = await auth.issue({ purpose: "create_user" });
    const token = tokenOf(issued.url);

    const challenge = await auth.challenge({ token });
    expect(challenge.issuer).toBe(SELF);
    // The URL stands as it did: asking is not spending, and the registration
    // that follows is the one the person came for.
    expect(auth.heldCounts.pending).toBe(1);
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const minted = await auth.register({
      token,
      code: issued.code,
      challenge,
      credential: await authenticator.create({
        challenge: challenge.challenge,
        origin: issued.origin,
        userId: issued.user as UserId,
      }),
    });
    expect(minted.session.user).toBe(issued.user as UserId);
  });

  test("a URL already spent, one past its window, and one that is not a token are one refusal", async () => {
    let now = 1_000_000;
    const { auth } = unit({ endpoint: ENDPOINT, now: () => now });

    // Spent: the person registered with it, and the page was opened again.
    const { issued } = await registeredAt(auth);
    expect(await refusal(auth.challenge({ token: tokenOf(issued.url) }))).toBe("auth_invalid");

    // Past its window, which the claims state — and which is only half of what
    // is checked, the other half being held at the issuer.
    const stale = await auth.issue({ purpose: "create_user", user: OTHER_USER });
    now += REGISTER_TTL_MS + 1;
    expect(await refusal(auth.challenge({ token: tokenOf(stale.url) }))).toBe("auth_invalid");

    // A value that is no token at all, which is the same answer again.
    expect(await refusal(auth.challenge({ token: "not.a.token" }))).toBe("auth_invalid");
  });

  test("a URL issued elsewhere is asked of its issuer, spent or not", async () => {
    const { peers } = linked([
      { self: SELF, endpoint: ENDPOINT },
      { self: OTHER_INSTANCE, endpoint: "https://next.example/" },
    ]);
    const [here, next] = peers as [Auth, Auth];
    const issued = await here.issue({ purpose: "create_user", origin: ORIGIN });
    const token = tokenOf(issued.url);

    // The page landed on the peer, which holds neither the secret nor the
    // record of the URL having been spent, and asks the instance that does.
    const challenge = await next.challenge({ token });
    expect(challenge.issuer).toBe(OTHER_INSTANCE);
    expect(here.heldCounts.pending).toBe(1);

    const authenticator = new SoftAuthenticator(issued.rp_id);
    await next.register({
      token,
      code: issued.code,
      challenge,
      credential: await authenticator.create({
        challenge: challenge.challenge,
        origin: issued.origin,
        userId: issued.user as UserId,
      }),
    });
    // Spent at the issuer, so the peer refuses the next page opened from it.
    expect(await refusal(next.challenge({ token }))).toBe("auth_invalid");
  });

  test("a URL whose issuer is nobody this instance can reach is the same refusal", async () => {
    // Issued at an instance this one has no way to ask — no mesh, or a peer
    // gone. Which of the three it was is not said: that a URL guessed at was
    // once real is not something an answer here may carry.
    const elsewhere = unit({ self: OTHER_INSTANCE, endpoint: "https://next.example/" }).auth;
    const issued = await elsewhere.issue({ purpose: "create_user", origin: ORIGIN });
    const { auth } = unit({ endpoint: ENDPOINT });
    expect(await refusal(auth.challenge({ token: tokenOf(issued.url) }))).toBe("auth_invalid");
  });

  test("the page asks over the route it was opened at, and is refused there", async () => {
    // End to end, because what a page holds is a URL and a fetch: the token
    // travels in the body of the challenge it asks for, and a URL that was
    // already used answers the one refusal before any form is filled in.
    const at = await serving();
    const issued = await at.instance.auth.issue({
      purpose: "create_user",
      origin: at.origin,
      endpoint: servedAt(at),
    });
    const good = await post(at, "challenge", { token: tokenOf(issued.url) });
    expect(good.ok).toBe(true);

    const user = issued.user as UserId;
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const challenge = (await good.json()) as { challenge: string };
    const registered = await post(at, "register", {
      token: tokenOf(issued.url),
      code: issued.code,
      credential: await authenticator.create({
        challenge: challenge.challenge,
        origin: at.origin,
        userId: user,
      }),
    });
    expect(registered.ok).toBe(true);

    const reopened = await post(at, "challenge", { token: tokenOf(issued.url) });
    expect(reopened.ok).toBe(false);
    expect(((await reopened.json()) as { error: { code: string } }).error.code).toBe(
      "auth_invalid",
    );
  });

  test("a challenge asked for without a token checks nothing", async () => {
    // The page signing in with a passkey that exists has no URL to be held to.
    const { auth } = unit({ endpoint: ENDPOINT });
    expect((await auth.challenge()).issuer).toBe(SELF);
  });
});
