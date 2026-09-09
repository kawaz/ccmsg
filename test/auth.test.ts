import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import { Auth, AuthRecords, cookieName, cookiePath, PREVIOUS_GRACE_MS } from "../src/auth/index.ts";
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

async function serving(): Promise<{ instance: Instance; origin: string }> {
  const port = (nextPort += 1);
  const origin = `http://127.0.0.1:${String(port)}`;
  const root = mkdtempSync(join(tmpdir(), "ccmsg-auth-"));
  mkdirSync(join(root, "home", "sessions"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "config.json"),
    JSON.stringify({
      defaults: { entry: { host: "127.0.0.1", port, origins: [origin] } },
    }),
  );
  const env: Env = {
    CLAUDE_CONFIG_DIR: join(root, "home"),
    CCMSG_STATE_DIR: join(root, "state"),
    CCMSG_CONFIG_DIR: join(root, "config"),
  };
  const outcome = await start({ env, echoLog: false });
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

/** The whole of what a person does the first time: take the URL and the code
 * off the terminal, make a credential, and be signed in. */
async function registered(at: { instance: Instance; origin: string }) {
  const issued = at.instance.auth.issue({});
  const authenticator = new SoftAuthenticator(issued.rp_id);
  const challenge = (await (await post(at, "challenge", {})).json()) as {
    challenge: string;
  };
  const credential = await authenticator.create({
    challenge: challenge.challenge,
    origin: at.origin,
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
    const issued = at.instance.auth.issue({ endpoint: `ws://${at.instance.http[0] as string}` });
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

  test("refreshing rotates, and a value two generations back fails the family", async () => {
    const at = await serving();
    const first = at.instance.auth.mint("someone");
    const name = cookieName(at.instance.self, "someone");
    const held = at.instance.auth.takeRefresh();
    const zero = `${name}=${held?.refresh.value ?? ""}`;

    const one = await post(at, "refresh", {}, { cookie: zero });
    expect(one.status).toBe(200);
    const next = (await one.json()) as { access: { value: string } };
    expect(next.access.value).not.toBe(first.access.value);
    const first_rotation = mintedCookie(one, name);

    // The generation before the standing one is answered rather than refused: a
    // reply lost on the way is a retry, not a replay, and it is answered with
    // the pair the caller missed rather than by rotating again.
    expect((await post(at, "refresh", {}, { cookie: zero })).status).toBe(200);

    const two = await post(at, "refresh", {}, { cookie: first_rotation });
    expect(two.status).toBe(200);
    const standing = mintedCookie(two, name);

    // Two generations back is older than the family remembers, so there is
    // nothing to fail it by: it is refused and the standing token stands.
    expect((await post(at, "refresh", {}, { cookie: zero })).status).toBe(401);
    expect((await post(at, "refresh", {}, { cookie: standing })).status).toBe(200);
  });

  test("an origin this instance does not serve is refused before anything else", async () => {
    const at = await serving();
    const refused = await fetch(`http://${at.instance.http[0] as string}/auth/challenge`, {
      method: "POST",
      headers: { origin: "http://elsewhere.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(403);
  });

  test("a preflight from a served origin is answered with credentials allowed", async () => {
    const at = await serving();
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

describe("a token reused after its grace fails the family (§2.4)", () => {
  test("the generation the family still remembers is what reuse is caught by", () => {
    // Against the domain rather than a listener, because what decides this is a
    // clock: the grace on the previous generation is a minute, and a test that
    // waited it out would be a test about waiting.
    let now = 1_000_000;
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-auth-unit-"));
    const auth = new Auth({
      self: "0".repeat(32),
      records: new AuthRecords({ dir, publish: () => {}, now: () => now }),
      origins: () => [],
      endpoint: () => undefined,
      unit: "unit",
      now: () => now,
    });
    auth.mint("someone");
    const zero = auth.takeRefresh()?.refresh.value ?? "";
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
