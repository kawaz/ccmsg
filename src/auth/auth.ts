import { createHmac, randomBytes, randomInt } from "node:crypto";
import type {
  AuthAssertArgs,
  AuthChallenge,
  AuthChallengeResult,
  AuthRecord,
  AuthRefreshArgs,
  AuthRefreshResult,
  AuthRegisterArgs,
  AuthResolveArgs,
  AuthResolveResult,
  AuthRotateArgs,
  AuthRotateResult,
  AuthSession,
  Base64Url,
  CredentialRecord,
  Endpoint,
  InstanceId,
  RegisterClaims,
  Subject,
  Timestamp,
  TokenFamily,
} from "@ccmsg/protocol";
import { AUTH_CHALLENGE_TTL_MS, REGISTER_TTL_MS } from "@ccmsg/protocol";
import { type HandlerInput, OpError, type Requester } from "../dispatch/index.ts";
import { AuthRecords, credentialKey, familyKey } from "./records.ts";
import { base64UrlEncode, equalStrings, verifyAssertion, verifyRegistration } from "./webauthn.ts";

/** How long an access token is accepted, and how long a refresh token is.
 *
 * Chosen rather than derived, within the DR's "hours" and "days" (§2.4). The
 * access token's life is also a connection's: a client renews on the
 * connection it already holds, so the period is what bounds a stolen token
 * rather than how often a person is interrupted. The refresh token's life is
 * how long a browser that was closed can come back without the authenticator. */
export const ACCESS_TTL_MS = 4 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long the generation before the standing one is still answered.
 *
 * It exists for one case: the rotation happened, the reply was lost, the client
 * retries with the value it still holds. That is a round trip, not a session,
 * so the window is short — long enough for a retry over a slow link and far too
 * short to be a second usable token. */
export const PREVIOUS_GRACE_MS = 60_000;

/** How many times a six-digit code may be got wrong before the registration URL
 * is spent.
 *
 * Five, because the code is what stands between a leaked URL and a
 * registration: a million codes and five tries is a chance no one plays for,
 * while a person mistyping twice still gets in. */
export const CODE_ATTEMPTS = 5;

/** How many `/auth/*` requests are answered per second, over all callers.
 *
 * The routes are reached before anything is proven, like the mesh's key
 * endpoint (§6), and the work behind them is a signature verification. The cap
 * is far above what a person at a keyboard produces and far below what would
 * cost this instance anything. */
export const AUTH_RATE_LIMIT = 30;
export const AUTH_RATE_WINDOW_MS = 1_000;

/** One registration URL that has been issued and not yet spent.
 *
 * Everything here dies with the process. The secret signs one URL and nothing
 * else, so there is no key to keep, rotate or protect — a restart loses it and
 * the remedy is to issue another URL (DR-0001 §2.2). */
interface Pending {
  readonly claims: RegisterClaims;
  readonly secret: Buffer;
  readonly code: string;
  attempts: number;
}

/** One challenge this instance issued, good once (§2.6). */
interface Issued {
  readonly expiresAt: Timestamp;
}

/** What a person's connection carries once an access token opened it. */
export interface AuthorizedConn {
  readonly sub: Subject;
  expiresAt: Timestamp;
}

export interface AuthDeps {
  readonly self: InstanceId;
  readonly records: AuthRecords;
  /** The pages allowed to run these exchanges: `clientDataJSON.origin` is
   * compared against this, and so is the CORS answer (§2.3). */
  readonly origins: () => readonly string[];
  /** Where this instance is dialed, which a registration URL is issued against
   * when the operator names none. */
  readonly endpoint: () => Endpoint | undefined;
  /** The instance's name as a person operates it, carried in the URL for
   * display. */
  readonly unit: string;
  /** Ask another instance one of the two ops only its issuer can answer.
   * Absent on an instance with no mesh, where an issuer that is not us is an
   * issuer that cannot be reached. */
  readonly ask?: (to: InstanceId, op: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly now?: () => Timestamp;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** What a registration URL is, as the command that made it prints it. */
export interface IssuedRegistration {
  readonly sub: Subject;
  readonly url: string;
  readonly code: string;
  readonly expires_at: Timestamp;
  readonly endpoint: Endpoint;
  readonly rp_id: string;
}

/** The person's authentication: the registration URLs this instance issued, the
 * challenges it holds, and the tokens it minted (DR-0001 §2.2-§2.6).
 *
 * What is written down is the records; everything here is memory, and every
 * one of those is short-lived by design. */
export class Auth {
  readonly #pending = new Map<string, Pending>();
  readonly #challenges = new Map<Base64Url, Issued>();
  readonly #authorized = new Map<Requester, AuthorizedConn>();
  #counter = 0;
  #window = 0;
  #served = 0;

  constructor(private readonly deps: AuthDeps) {}

  get records(): AuthRecords {
    return this.deps.records;
  }

  #now(): Timestamp {
    return (this.deps.now ?? Date.now)();
  }

  // --- issuing a registration URL (§2.2) ---

  /** Make one registration URL and the code that goes with it.
   *
   * The two halves reach the browser by different routes: the URL is carried
   * there by whoever was given it, and the code is only ever shown on the
   * terminal this ran on. Somebody holding the URL alone cannot register. */
  issue(options: {
    readonly endpoint?: Endpoint;
    readonly rpId?: string;
    readonly label?: string;
    readonly sub?: Subject;
  }): IssuedRegistration {
    const endpoint = options.endpoint ?? this.deps.endpoint();
    if (endpoint === undefined) {
      throw new OpError(
        "invalid_args",
        "この instance には endpoint が無いので、登録先の URL を引数で渡してください",
      );
    }
    const host = hostOf(endpoint);
    const rpId = options.rpId ?? host;
    // The relying party is a domain the endpoint's host belongs to, and nothing
    // wider: a credential made for a suffix this instance does not sit under
    // would be usable at every other host under it (§2.3).
    if (!isRegistrableSuffix(rpId, host)) {
      throw new OpError("invalid_args", `${rpId} は ${host} の登録可能なドメインではありません`);
    }
    this.#counter += 1;
    const sub = options.sub ?? `${this.deps.unit}-${String(this.#counter)}`;
    if (this.deps.records.removed(sub)) {
      throw new OpError("forbidden", `${sub} は削除済みなので、この名前では登録できません`);
    }
    const at = this.#now();
    const claims: RegisterClaims = {
      iss: this.deps.self,
      sub,
      unit: this.deps.unit,
      endpoint,
      rp_id: rpId,
      expires_at: at + REGISTER_TTL_MS,
      jti: randomBytes(16).toString("base64url"),
      ...(options.label === undefined ? {} : { issued_label: options.label }),
    };
    const secret = randomBytes(32);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.#pending.set(claims.jti, { claims, secret, code, attempts: 0 });
    return {
      sub,
      url: `${webOrigin(endpoint)}/#register=${sign(claims, secret)}`,
      code,
      expires_at: claims.expires_at,
      endpoint,
      rp_id: rpId,
    };
  }

  /** The credentials a person may read back, newest registration first. */
  list(): CredentialRecord[] {
    return this.deps.records
      .credentials()
      .sort((left, right) => right.registered_at - left.registered_at);
  }

  /** Remove one person: the tombstones, and every connection they hold. */
  remove(sub: Subject): { records: AuthRecord[]; closed: number } {
    const records = this.deps.records.remove(sub);
    let closed = 0;
    for (const [conn, held] of this.#authorized) {
      if (held.sub !== sub) continue;
      this.#authorized.delete(conn);
      conn.close();
      closed += 1;
    }
    return { records, closed };
  }

  // --- challenges (§2.6) ---

  challenge(): AuthChallengeResult {
    this.#forget();
    const value = base64UrlEncode(randomBytes(32));
    const expiresAt = this.#now() + AUTH_CHALLENGE_TTL_MS;
    this.#challenges.set(value, { expiresAt });
    return { challenge: value, issuer: this.deps.self, expires_at: expiresAt };
  }

  /** Spend one challenge this instance issued. Good once: the second call for
   * the same value finds nothing, which is a refusal. */
  spend(value: Base64Url): void {
    this.#forget();
    const held = this.#challenges.get(value);
    if (held === undefined) throw new OpError("auth_invalid", "この challenge は使えません");
    this.#challenges.delete(value);
  }

  /** Spend a challenge wherever it was issued: here, or at the instance the
   * caller says issued it (§2.4, behind a load balancer either may be
   * reached). */
  async #spendAnywhere(challenge: AuthChallenge): Promise<void> {
    if (challenge.issuer === this.deps.self) {
      this.spend(challenge.challenge);
      return;
    }
    await this.#atIssuer(challenge.issuer, "auth_resolve", {
      kind: "challenge",
      challenge: challenge.challenge,
    } satisfies AuthResolveArgs);
  }

  /** Spend a challenge whose issuer nobody stated: here when this instance
   * issued it, and at the named instance when it did not. */
  async #spendHereOrAt(challenge: Base64Url, elsewhere: InstanceId): Promise<void> {
    if (this.#holds(challenge) || elsewhere === this.deps.self) {
      this.spend(challenge);
      return;
    }
    await this.#atIssuer(elsewhere, "auth_resolve", {
      kind: "challenge",
      challenge,
    } satisfies AuthResolveArgs);
  }

  #holds(challenge: Base64Url): boolean {
    this.#forget();
    return this.#challenges.has(challenge);
  }

  #atIssuer(iss: InstanceId, op: string, args: Record<string, unknown>): Promise<unknown> {
    const ask = this.deps.ask;
    if (ask === undefined) {
      throw new OpError("auth_unknown_issuer", `${iss} には問い合わせられません`);
    }
    return ask(iss, op, args);
  }

  // --- registration (§2.2) ---

  /** Verify a registration and write the credential down.
   *
   * The registration URL is checked where its secret is, which may be another
   * instance; everything else — the WebAuthn verification, the record — is done
   * here, by whoever the browser reached (§2.6). */
  async register(
    args: AuthRegisterArgs,
    from: { ip?: string; userAgent?: string } = {},
  ): Promise<AuthSession> {
    const claims = await this.#claimsOf(args);
    if (this.deps.records.removed(claims.sub)) {
      throw new OpError("forbidden", `${claims.sub} は削除済みです`);
    }
    // The challenge the page answered is one this cluster issued, spent before
    // anything is verified against it. It is read out of the client data
    // because a registration carries no challenge field of its own: what the
    // authenticator signed is the only value worth spending, and where it was
    // issued is not stated — so it is spent here when this instance holds it,
    // and at the registration's issuer otherwise.
    const challenge = challengeIn(args.credential.client_data_json);
    await this.#spendHereOrAt(challenge, claims.iss);
    const verified = verifyRegistration(args.credential, {
      challenge,
      origins: this.deps.origins(),
      rpId: claims.rp_id,
    });
    if (this.deps.records.credential(verified.credentialId) !== undefined) {
      throw new OpError("auth_invalid", "この credential は既に登録されています");
    }
    const at = this.#now();
    const record: CredentialRecord = {
      kind: "credential",
      sub: claims.sub,
      credential_id: verified.credentialId,
      public_key: verified.publicKey,
      user_handle: args.credential.raw_id,
      sign_count: verified.signCount,
      ...(claims.issued_label === undefined ? {} : { issued_label: claims.issued_label }),
      ...(args.device_label === undefined ? {} : { device_label: args.device_label }),
      registered_at: at,
      ...(from.ip === undefined ? {} : { registered_ip: from.ip }),
      ...(from.userAgent === undefined ? {} : { registered_user_agent: from.userAgent }),
    };
    this.deps.records.write(credentialKey(claims.sub, verified.credentialId), record, at);
    return this.mint(claims.sub);
  }

  /** What a registration URL authorized, from here or from its issuer. */
  async #claimsOf(args: AuthRegisterArgs): Promise<RegisterClaims> {
    const stated = claimsOf(args.token);
    if (stated.iss !== this.deps.self) {
      const answer = (await this.#atIssuer(stated.iss, "auth_resolve", {
        kind: "register",
        token: args.token,
      } satisfies AuthResolveArgs)) as AuthResolveResult;
      if (answer.kind !== "register") {
        throw new OpError("auth_invalid", "登録 URL の発行者が別のものを答えました");
      }
      return answer.claims;
    }
    return this.resolveRegistration(args.token, args.code);
  }

  /** Check a registration URL against the secret that signed it, and spend it.
   *
   * Only the issuer can run this, which is what `auth_resolve` is for. The code
   * is checked here too: it was issued with the secret and is held beside it,
   * and letting another instance check it would be putting the one defence
   * against a leaked URL somewhere the URL's holder could reach. */
  resolveRegistration(token: string, code?: string): RegisterClaims {
    const stated = claimsOf(token);
    const held = this.#pending.get(stated.jti);
    if (held === undefined) {
      throw new OpError("auth_expired", "この登録 URL は使えません。再発行してください");
    }
    if (held.claims.expires_at <= this.#now()) {
      this.#pending.delete(stated.jti);
      throw new OpError("auth_expired", "この登録 URL は期限切れです。再発行してください");
    }
    if (!equalStrings(token, sign(held.claims, held.secret))) {
      throw new OpError("auth_invalid", "この登録 URL の署名が合いません");
    }
    if (code === undefined || !equalStrings(code, held.code)) {
      held.attempts += 1;
      // The URL itself is spent once the tries are gone, so guessing the code
      // costs the whole registration rather than one attempt (§2.2).
      if (held.attempts >= CODE_ATTEMPTS) {
        this.#pending.delete(stated.jti);
        throw new OpError(
          "auth_expired",
          "コードの入力を間違えすぎました。URL を再発行してください",
        );
      }
      throw new OpError("auth_invalid", "コードが違います");
    }
    this.#pending.delete(stated.jti);
    return held.claims;
  }

  // --- assertion (§2.5) ---

  async assert(
    args: AuthAssertArgs,
    from: { ip?: string; userAgent?: string } = {},
  ): Promise<AuthSession> {
    const record = this.deps.records.credential(args.credential.raw_id);
    if (record === undefined) {
      throw new OpError("auth_invalid", "この credential は登録されていません");
    }
    await this.#spendAnywhere(args.challenge);
    const rpId = this.#rpIdFor();
    const { signCount } = await verifyAssertion(
      args.credential,
      {
        publicKey: record.public_key,
        ...(record.sign_count === undefined ? {} : { signCount: record.sign_count }),
      },
      { challenge: args.challenge.challenge, origins: this.deps.origins(), rpId },
    );
    const at = this.#now();
    this.deps.records.write(
      credentialKey(record.sub, record.credential_id),
      {
        ...record,
        sign_count: signCount,
        last_used_at: at,
        ...(from.ip === undefined ? {} : { last_used_ip: from.ip }),
        ...(from.userAgent === undefined ? {} : { last_used_user_agent: from.userAgent }),
      },
      at,
    );
    return this.mint(record.sub);
  }

  /** The relying party this instance verifies against.
   *
   * The endpoint's host, which is the default a registration is issued with. An
   * instance whose credentials were registered against a wider suffix is one
   * whose `rp_id` differs from this, and an assertion is checked against what
   * the credential was made for — so the record's own registration decides,
   * with the host as the answer where nothing else is known. */
  #rpIdFor(): string {
    const endpoint = this.deps.endpoint();
    if (endpoint === undefined)
      throw new OpError("auth_invalid", "この instance は endpoint を持ちません");
    return hostOf(endpoint);
  }

  // --- tokens (§2.4) ---

  /** Make a family for this person, minted by this instance. */
  mint(sub: Subject): AuthSession {
    const at = this.#now();
    const family: TokenFamily = {
      kind: "token_family",
      sub,
      iss: this.deps.self,
      access: { value: token(), expires_at: at + ACCESS_TTL_MS },
      refresh: { value: token(), expires_at: at + REFRESH_TTL_MS },
    };
    const id = randomBytes(8).toString("hex");
    this.deps.records.write(familyKey(sub, id), family, at);
    this.#minted = { sub, refresh: family.refresh };
    return { sub, access: family.access };
  }

  /** The refresh token the last mint or rotation produced, for the carrier that
   * has to put it in a cookie.
   *
   * Kept aside rather than answered by the op because the contract's result
   * deliberately does not carry it: a body the page's script can read is the
   * one thing the cookie exists to prevent (contract, `AuthSession`). */
  #minted: { sub: Subject; refresh: { value: Base64Url; expires_at: Timestamp } } | undefined;

  takeRefresh():
    | { sub: Subject; refresh: { value: Base64Url; expires_at: Timestamp } }
    | undefined {
    const held = this.#minted;
    this.#minted = undefined;
    return held;
  }

  /** Rotate a family from a refresh token, wherever it was minted.
   *
   * A family is written by its `iss` alone, so a rotation that landed here for
   * a family minted elsewhere is carried there rather than done here — two
   * instances rotating one family in parallel would merge by last write and
   * read exactly like a stolen token being replayed (§2.4). */
  async refreshToken(value: Base64Url): Promise<AuthSession> {
    const held = this.deps.records.byRefresh(value);
    if (held === undefined) {
      // Not the standing generation, nor the one before it. Either it never was
      // one, or it is a value that has already been rotated away — which is a
      // token being reused, and fails the family it belongs to.
      this.#failReused(value);
      throw new OpError("auth_invalid", "この refresh token は使えません");
    }
    if (held.body.iss !== this.deps.self) {
      const answer = (await this.#atIssuer(held.body.iss, "auth_rotate", {
        refresh_token: value,
      } satisfies AuthRotateArgs)) as AuthRotateResult;
      this.#minted = { sub: answer.sub, refresh: answer.refresh };
      return { sub: answer.sub, access: answer.access };
    }
    const rotated = this.rotate(value);
    this.#minted = { sub: rotated.sub, refresh: rotated.refresh };
    return { sub: rotated.sub, access: rotated.access };
  }

  /** Rotate a family this instance minted. The one writer's own operation, and
   * what `auth_rotate` runs on its behalf. */
  rotate(value: Base64Url): AuthRotateResult {
    const held = this.deps.records.byRefresh(value);
    if (held === undefined) {
      this.#failReused(value);
      throw new OpError("auth_invalid", "この refresh token は使えません");
    }
    if (held.body.iss !== this.deps.self) {
      throw new OpError("auth_invalid", `この family を書けるのは ${held.body.iss} だけです`);
    }
    // Answering the previous generation with the standing pair rather than
    // rotating again: the client that retries is asking for the answer it
    // missed, and rotating on a retry would spend a generation per lost reply.
    if (held.previous) {
      return { sub: held.body.sub, access: held.body.access, refresh: held.body.refresh };
    }
    const at = this.#now();
    const rotated: TokenFamily = {
      kind: "token_family",
      sub: held.body.sub,
      iss: this.deps.self,
      access: { value: token(), expires_at: at + ACCESS_TTL_MS },
      refresh: { value: token(), expires_at: at + REFRESH_TTL_MS },
      previous_refresh: { value: held.body.refresh.value, expires_at: at + PREVIOUS_GRACE_MS },
    };
    this.deps.records.write(held.key, rotated, at);
    return { sub: rotated.sub, access: rotated.access, refresh: rotated.refresh };
  }

  /** A value that is nobody's standing token but was somebody's: the family it
   * belonged to is failed, because a token in use twice is a token that was
   * taken (§2.4). */
  #failReused(value: Base64Url): void {
    for (const held of this.deps.records.families()) {
      const before = held.body.previous_refresh;
      const stale =
        equalStrings(held.body.refresh.value, value) ||
        (before !== undefined && equalStrings(before.value, value));
      if (!stale) continue;
      if (held.body.iss !== this.deps.self) continue;
      this.deps.log?.("a refresh token was reused after it was rotated away", {
        sub: held.body.sub,
      });
      this.deps.records.fail(held.key);
    }
  }

  // --- connections (§2.5) ---

  /** Whether an access token opens a connection, and until when. */
  admits(access: Base64Url): { sub: Subject; expiresAt: Timestamp } | undefined {
    const family = this.deps.records.byAccess(access);
    if (family === undefined) return undefined;
    return { sub: family.sub, expiresAt: family.access.expires_at };
  }

  /** Take a connection an access token opened, and close it when the token runs
   * out. The client is expected to have extended it before then; one that did
   * not is the one this is for. */
  hold(conn: Requester, admitted: { sub: Subject; expiresAt: Timestamp }): void {
    const held: AuthorizedConn = { sub: admitted.sub, expiresAt: admitted.expiresAt };
    this.#authorized.set(conn, held);
    conn.onClose(() => {
      this.#authorized.delete(conn);
    });
    this.#deadline(conn, held);
  }

  #deadline(conn: Requester, held: AuthorizedConn): void {
    const timer = setTimeout(
      () => {
        const standing = this.#authorized.get(conn);
        if (standing === undefined) return;
        // Extended while this was waiting: the deadline moved, so the close is
        // scheduled again for where it moved to rather than run now.
        if (standing.expiresAt > this.#now()) {
          this.#deadline(conn, standing);
          return;
        }
        this.#authorized.delete(conn);
        conn.close();
      },
      Math.max(0, held.expiresAt - this.#now()),
    );
    timer.unref?.();
  }

  /** When this connection's authorization runs out, for `hello` to state. */
  expiresAt(conn: Requester): Timestamp | undefined {
    return this.#authorized.get(conn)?.expiresAt;
  }

  /** Extend a live connection with a token got from `/auth/refresh` (§2.5). */
  extend(conn: Requester, args: AuthRefreshArgs): AuthRefreshResult {
    const held = this.#authorized.get(conn);
    if (held === undefined) {
      throw new OpError("auth_invalid", "この接続は token で開かれたものではありません");
    }
    const admitted = this.admits(args.access_token);
    if (admitted === undefined) throw new OpError("auth_expired", "この access token は使えません");
    // A token belonging to somebody else does not extend this connection: the
    // connection is one person's, and a second person's token would move its
    // deadline without changing who it speaks as.
    if (admitted.sub !== held.sub) {
      throw new OpError("auth_invalid", "この access token は別の利用者のものです");
    }
    held.expiresAt = admitted.expiresAt;
    return { auth_expires_at: admitted.expiresAt };
  }

  // --- the rate limit the unauthenticated routes share (§2.4) ---

  allowRequest(): boolean {
    const now = this.#now();
    if (now - this.#window >= AUTH_RATE_WINDOW_MS) {
      this.#window = now;
      this.#served = 0;
    }
    this.#served += 1;
    return this.#served <= AUTH_RATE_LIMIT;
  }

  /** Drop what has run out. Read rather than swept, like everything else that
   * expires here (M3). */
  #forget(): void {
    const now = this.#now();
    for (const [value, held] of this.#challenges) {
      if (held.expiresAt <= now) this.#challenges.delete(value);
    }
    for (const [jti, held] of this.#pending) {
      if (held.claims.expires_at <= now) this.#pending.delete(jti);
    }
  }

  /** What is held per exchange right now, so a test can state that a finished
   * registration leaves nothing behind. */
  get held(): { pending: number; challenges: number; connections: number } {
    this.#forget();
    return {
      pending: this.#pending.size,
      challenges: this.#challenges.size,
      connections: this.#authorized.size,
    };
  }
}

/** The three ops an instance answers on a person's behalf, and the two it
 * answers for another instance. */
export function authHandlers(auth: Auth) {
  return {
    auth_challenge: (): AuthChallengeResult => auth.challenge(),
    auth_register: (input: HandlerInput): Promise<AuthSession> =>
      auth.register(input.args as unknown as AuthRegisterArgs),
    auth_assert: (input: HandlerInput): Promise<AuthSession> =>
      auth.assert(input.args as unknown as AuthAssertArgs),
    auth_refresh: (input: HandlerInput): AuthRefreshResult =>
      auth.extend(input.conn, input.args as unknown as AuthRefreshArgs),
    auth_resolve: (input: HandlerInput): AuthResolveResult => {
      const args = input.args as unknown as AuthResolveArgs;
      if (args.kind === "challenge") {
        auth.spend(args.challenge);
        return { kind: "challenge" };
      }
      // The code is not carried between instances: it is checked where it was
      // issued, by the instance the browser reached asking this one to spend
      // the registration — which is this one, holding both halves (§2.2).
      return { kind: "register", claims: auth.resolveRegistration(args.token) };
    },
    auth_rotate: (input: HandlerInput): AuthRotateResult =>
      auth.rotate((input.args as unknown as AuthRotateArgs).refresh_token),
  };
}

/** A token: 32 bytes of randomness, spelled the way everything on this wire is. */
function token(): Base64Url {
  return base64UrlEncode(randomBytes(32));
}

/** Sign the claims with the secret made for this one registration.
 *
 * A JWS with HS256, because the value travels in a URL fragment and has to
 * survive being carried there: the shape is the conventional one, and the
 * verifier is the issuer itself, so nothing about it is a key anyone else
 * needs (§2.2). */
function sign(claims: RegisterClaims, secret: Buffer): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signing = `${header}.${body}`;
  return `${signing}.${createHmac("sha256", secret).update(signing).digest("base64url")}`;
}

/** What a registration token says about itself, before anything has checked it.
 *
 * Read to find the issuer, which is who can check the rest. Nothing here is
 * believed: an issuer a caller made up names an instance that holds no such
 * registration, which is a refusal. */
export function claimsOf(token: string): RegisterClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OpError("auth_invalid", "登録 URL の token が壊れています");
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
  } catch {
    throw new OpError("auth_invalid", "登録 URL の token が読めません");
  }
  const held = claims as Partial<RegisterClaims>;
  if (
    typeof held.iss !== "string" ||
    typeof held.jti !== "string" ||
    typeof held.sub !== "string"
  ) {
    throw new OpError("auth_invalid", "登録 URL の token に発行者がありません");
  }
  return held as RegisterClaims;
}

/** The challenge a client data object states, read before anything is verified
 * so the value can be spent at whoever issued it. */
function challengeIn(clientDataJson: Base64Url): Base64Url {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(clientDataJson, "base64url").toString("utf8"));
  } catch {
    throw new OpError("auth_invalid", "client data が読めません");
  }
  const challenge = (parsed as { challenge?: unknown }).challenge;
  if (typeof challenge !== "string") {
    throw new OpError("auth_invalid", "client data に challenge がありません");
  }
  return challenge;
}

/** The host an endpoint names, which is the relying party by default (§2.3). */
export function hostOf(endpoint: Endpoint): string {
  return new URL(endpoint).hostname;
}

/** Where the page that runs the registration is served from: the endpoint's
 * origin over HTTP, which is where the web UI sits in the ordinary
 * configuration (§2.3). */
export function webOrigin(endpoint: Endpoint): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const origin = url.origin;
  const path = url.pathname.replace(/\/$/, "");
  return `${origin}${path}`;
}

/** Whether a relying party id is the host or a domain the host sits under.
 *
 * The WebAuthn rule as far as this instance can check it: a credential made
 * for a suffix the endpoint does not sit under would be usable at hosts this
 * instance has nothing to do with. Whether the suffix is one a registrar hands
 * out is the browser's to refuse, and it does. */
export function isRegistrableSuffix(rpId: string, host: string): boolean {
  return host === rpId || host.endsWith(`.${rpId}`);
}
