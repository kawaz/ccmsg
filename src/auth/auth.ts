import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import type {
  AuthAssertArgs,
  AuthChallenge,
  AuthChallengeResult,
  AuthRecord,
  AuthExtendArgs,
  AuthRefreshReason,
  AuthExtendResult,
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
  WebUi,
} from "@ccmsg/protocol";
import {
  AUTH_CHALLENGE_TTL_MS,
  AuthResolveResult as AuthResolveResultSchema,
  AuthRotateResult as AuthRotateResultSchema,
  Endpoint as EndpointSchema,
  originOf,
  REGISTER_TTL_MS,
  rpIdOf,
  validationErrors,
  WebUi as WebUiSchema,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError, type Requester } from "../dispatch/index.ts";
import { AuthRecords, credentialKey, familyKey } from "./records.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  checkPublicKey,
  equalBytes,
  equalStrings,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
} from "./webauthn.ts";
import { CborError } from "./cbor.ts";

/** How long an access token is accepted, and how long a refresh token is.
 *
 * Chosen rather than derived, within the DR's "hours" and "days" (DR-0001 §2.4). The
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

/** How much of an access token's life must be left for a rotation to keep it.
 *
 * A family has one access token and every page a person has open presents it,
 * so minting a new one on each rotation would take the token out from under the
 * pages that are already holding it. Rotation therefore keeps the standing
 * access token while it has this much life left, and mints only when it is
 * running out — the pages share one token and renew it together.
 *
 * Half, because it is the largest share that still leaves a full half of the
 * token's life to notice the new value in: the window is what bounds how long a
 * page may go on holding a token whose family has already moved on. */
export const ACCESS_KEEP_MS = ACCESS_TTL_MS / 2;

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
 * endpoint (mesh-peer-auth §6), and the work behind them is a signature verification. The cap
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

/** One challenge this instance issued, good once (DR-0001 §2.6). */
interface Issued {
  readonly expiresAt: Timestamp;
}

/** What a person's connection carries once an access token opened it. */
export interface AuthorizedConn {
  readonly sub: Subject;
  expiresAt: Timestamp;
  /** The close scheduled for the deadline, cleared when the connection goes so
   * a departed connection leaves no timer behind. */
  timer?: ReturnType<typeof setTimeout>;
}

export interface AuthDeps {
  readonly self: InstanceId;
  readonly records: AuthRecords;
  /** Where this instance is reached, which a registration URL is issued against
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

/** A person's session as this instance just minted it: what the caller is told,
 * and the refresh token whoever ran the op has to put in a cookie.
 *
 * The two travel together rather than through a slot on this object, because
 * two exchanges may be in flight at once and a slot would hand one caller the
 * other's token. The contract keeps the refresh token out of the op's result on
 * purpose (`AuthSession`), so it is answered here and the carrier is what
 * decides where it goes. */
export interface MintedSession {
  readonly session: AuthSession;
  readonly refresh: { readonly value: Base64Url; readonly expires_at: Timestamp };
  /** The web UI the family is held to, which is what the carrier reads to know
   * whether its cookie crosses sites (DR-0028). */
  readonly webui: WebUi;
}

/** What is known about the client that asked for a refresh: its own word for
 * why, and what the carrier observed of it.
 *
 * Kept on the family as `last_refresh` and read by nobody but the person whose
 * sessions they are — a run of `reconnect` at an hour they were asleep is
 * something to recognise. Nothing here is checked, so nothing may turn on it. */
export interface RefreshFrom {
  readonly reason?: AuthRefreshReason;
  readonly ip?: string;
  readonly userAgent?: string;
}

/** What a registration URL is, as the command that made it prints it. */
export interface IssuedRegistration {
  readonly sub: Subject;
  readonly url: string;
  readonly code: string;
  /** The WebAuthn user handle this subject is known by, which the page creates
   * the credential against. It is also inside the URL's claims; it is stated
   * here so the command that issued the URL can show what it settled. */
  readonly user_id: Base64Url;
  readonly expires_at: Timestamp;
  readonly endpoint: Endpoint;
  /** Where the URL sends the person, which is the page the credential will be
   * made by. */
  readonly webui: WebUi;
  /** The relying party the page will create the credential under, read off the
   * web UI's URL (contract, `rpIdOf`). Stated so the command that issued the
   * URL can show what the browser will be asked for; it is a derived value and
   * is kept nowhere. */
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
  #window = 0;
  #served = 0;

  constructor(private readonly deps: AuthDeps) {}

  get records(): AuthRecords {
    return this.deps.records;
  }

  /** Where this instance is published, for the carrier that has to know which
   * site its cookie belongs to (DR-0028). Absent on an instance the mesh names
   * no address for, which is one that serves the unix socket alone. */
  endpoint(): Endpoint | undefined {
    return this.deps.endpoint();
  }

  #now(): Timestamp {
    return (this.deps.now ?? Date.now)();
  }

  // --- issuing a registration URL (DR-0001 §2.2) ---

  /** Make one registration URL and the code that goes with it.
   *
   * The two halves reach the browser by different routes: the URL is carried
   * there by whoever was given it, and the code is only ever shown on the
   * terminal this ran on. Somebody holding the URL alone cannot register. */
  issue(options: {
    readonly endpoint?: Endpoint;
    readonly webui?: WebUi;
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
    // An operator types these, so they are read here rather than trusted: an
    // address that is not a base URL would be written into the record and be
    // compared, forever after, against a request that can never match it.
    this.#baseUrl("endpoint", EndpointSchema, endpoint);
    // The page the credential will be made by. It defaults to the endpoint
    // because an instance that serves its own web UI is the ordinary case; a UI
    // published anywhere else is named here, and the URL a person is handed is
    // that UI's rather than this instance's (contract, `RegisterClaims.webui`).
    const webui = (options.webui ?? endpoint) as WebUi;
    this.#baseUrl("webui", WebUiSchema, webui);
    // The relying party and the origin are both read off that URL, every time
    // they are needed, rather than settled here and carried (contract,
    // `originOf` / `rpIdOf`).
    const rpId = rpIdOf(webui);
    const sub = options.sub ?? this.#nextSubject();
    if (this.deps.records.removed(sub)) {
      throw new OpError("forbidden", `${sub} は削除済みなので、この名前では登録できません`);
    }
    const at = this.#now();
    const claims: RegisterClaims = {
      iss: this.deps.self,
      sub,
      unit: this.deps.unit,
      endpoint,
      webui,
      expires_at: at + REGISTER_TTL_MS,
      jti: randomBytes(16).toString("base64url"),
      user_id: this.#userIdFor(sub),
      ...(options.label === undefined ? {} : { issued_label: options.label }),
    };
    const secret = randomBytes(32);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.#pending.set(claims.jti, { claims, secret, code, attempts: 0 });
    return {
      sub,
      // The web UI is where the person is sent; the endpoint is named inside
      // the claims, because the registration has to come back to the instance
      // that holds the secret and the code (contract, DR-0029).
      url: `${webui}#register=${sign(claims, secret)}`,
      code,
      user_id: claims.user_id,
      expires_at: claims.expires_at,
      endpoint,
      webui,
      rp_id: rpId,
    };
  }

  /** Read one base URL an operator stated, in the contract's own spelling. */
  #baseUrl(name: string, schema: Parameters<typeof validationErrors>[0], url: string): void {
    const problems = validationErrors(schema, url);
    if (problems.length > 0) {
      throw new OpError(
        "invalid_args",
        `${name} は末尾が / の http(s) base URL です (${url}): ${problems.join("; ")}`,
      );
    }
  }

  /** The WebAuthn user handle this subject is known by.
   *
   * Settled once per subject and reused for every later registration of it: the
   * authenticator keeps the handle beyond this instance's reach, so a second
   * value for one person would show up on their device as a second account
   * (contract, `RegisterClaims.user_id`). A subject that already has a
   * credential is registered against the handle that credential carries; a
   * subject in the middle of another registration, against the one that
   * registration named.
   *
   * Sixteen bytes, which is what the specification recommends and what the page
   * would otherwise have had to choose. */
  #userIdFor(sub: Subject): Base64Url {
    for (const record of this.deps.records.credentials()) {
      if (record.sub === sub) return record.user_handle;
    }
    for (const held of this.#pending.values()) {
      if (held.claims.sub === sub) return held.claims.user_id;
    }
    return base64UrlEncode(randomBytes(16));
  }

  /** The next `<unit>-N` nobody holds.
   *
   * Read from the records rather than counted in memory: a counter would start
   * at one again after a restart and hand the next person a name somebody
   * already has, which would be a second person under one subject rather than a
   * new one. A name a removal took is skipped too — the tombstone over it
   * refuses every later write, so issuing it would produce a URL that cannot
   * complete.
   *
   * The pending registrations count as taken as well: two URLs made before
   * either is spent are two people. */
  #nextSubject(): Subject {
    const prefix = `${this.deps.unit}-`;
    const taken = new Set<string>();
    for (const record of this.deps.records.credentials()) taken.add(record.sub);
    for (const held of this.#pending.values()) taken.add(held.claims.sub);
    let highest = 0;
    for (const sub of taken) {
      if (!sub.startsWith(prefix)) continue;
      const counted = Number(sub.slice(prefix.length));
      if (Number.isInteger(counted) && counted > highest) highest = counted;
    }
    for (let next = highest + 1; ; next += 1) {
      const sub = `${prefix}${String(next)}`;
      if (!taken.has(sub) && !this.deps.records.removed(sub)) return sub;
    }
  }

  /** The credentials a person may read back, newest registration first. */
  list(): CredentialRecord[] {
    return this.deps.records
      .credentials()
      .sort((left, right) => right.registered_at - left.registered_at);
  }

  /** Remove one person: the tombstones, and every connection they hold. */
  async remove(sub: Subject): Promise<{ records: AuthRecord[]; closed: number }> {
    const records = await this.deps.records.remove(sub);
    return { records, closed: this.disconnect(sub) };
  }

  /** Close every connection one person holds.
   *
   * The other half of a removal, and the half that has to run whoever decided
   * it: a tombstone that arrived from a peer revokes the same person here, and
   * a connection left open on a revoked credential is the removal not having
   * happened (DR-0001 §2.6). Failing a family reaches this the same way. */
  disconnect(sub: Subject): number {
    let closed = 0;
    for (const [conn, held] of this.#authorized) {
      if (held.sub !== sub) continue;
      clearTimeout(held.timer);
      this.#authorized.delete(conn);
      conn.close();
      closed += 1;
    }
    return closed;
  }

  /** Take what a peer wrote on `auth.records`, and act on the removals in it. */
  async merge(records: readonly AuthRecord[]): Promise<void> {
    const { removed } = await this.deps.records.merge(records);
    for (const sub of removed) this.disconnect(sub);
  }

  // --- challenges (DR-0001 §2.6) ---

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
   * caller says issued it (DR-0001 §2.4, behind a load balancer either may be
   * reached). */
  async #spendAnywhere(challenge: AuthChallenge): Promise<void> {
    if (challenge.issuer === this.deps.self) {
      this.spend(challenge.challenge);
      return;
    }
    await this.#atIssuer(challenge.issuer, "auth.resolve", {
      kind: "challenge",
      challenge: challenge.challenge,
    } satisfies AuthResolveArgs);
  }

  /** Spend the challenge a registration answered.
   *
   * Stated with its issuer, it is spent wherever that is. Left unstated, it can
   * only be honoured where this instance holds it — a value nobody named an
   * issuer for is one there is nobody to ask about. */
  async #spendStated(challenge: Base64Url, stated: AuthChallenge | undefined): Promise<void> {
    if (stated === undefined) {
      this.spend(challenge);
      return;
    }
    if (!equalStrings(stated.challenge, challenge)) {
      throw new OpError("auth_invalid", "答えた challenge と名乗った challenge が違います");
    }
    await this.#spendAnywhere(stated);
  }

  #atIssuer(iss: InstanceId, op: string, args: Record<string, unknown>): Promise<unknown> {
    const ask = this.deps.ask;
    if (ask === undefined) {
      throw new OpError("auth_unknown_issuer", `${iss} には問い合わせられません`);
    }
    return ask(iss, op, args);
  }

  /** Ask the issuer, and read its answer against the contract before anything
   * turns on it.
   *
   * What comes back is a peer's word, not a guarantee: an instance a version
   * behind, or one with a bug, answers something shaped otherwise, and a record
   * built out of that would be written down and handed to every peer. So an
   * answer that is not the op's result is `internal_error` — the caller's
   * arguments were right, and the failure is between the instances (DR-0015
   * §2.5). */
  async #answerOf<T>(
    iss: InstanceId,
    op: string,
    args: Record<string, unknown>,
    result: Parameters<typeof validationErrors>[0],
  ): Promise<T> {
    const answer = await this.#atIssuer(iss, op, args);
    const problems = validationErrors(result, answer);
    if (problems.length > 0) {
      this.deps.log?.("an issuer answered outside the contract", { iss, op, problems });
      throw new OpError("internal_error", `${iss} の ${op} の答えが契約の形ではありません`);
    }
    return answer as T;
  }

  // --- registration (DR-0001 §2.2) ---

  /** Verify a registration and write the credential down.
   *
   * The registration URL is checked where its secret is, which may be another
   * instance; everything else — the WebAuthn verification, the record — is done
   * here, by whoever the browser reached (DR-0001 §2.6). */
  async register(
    args: AuthRegisterArgs,
    from: { ip?: string; userAgent?: string; path?: string; origin?: string | null } = {},
  ): Promise<MintedSession> {
    // What the URL says about itself, before anything has vouched for it. It is
    // read to know which relying party the credential should have been made
    // under; nothing is decided by it, because the same fields come back
    // authenticated below and the two are held to each other.
    const stated = claimsOf(args.token);
    // The endpoint this URL was issued for is where it may be spent: a
    // registration posted to a neighbour sharing the host is a registration at
    // an instance the URL never named (contract, `CredentialRecord.endpoint`).
    this.#servedHere(stated.endpoint, from.path);
    // The page has to be the one the URL sends people to. What the carrier
    // observed of it is held to the same value the ceremony is (contract,
    // DR-0029), and a request that states no origin has not passed this gate.
    this.#cameFrom(stated.webui, from.origin);
    // What the page answered, verified before anything is spent: a challenge is
    // good once, so consuming it for a message that then fails to verify would
    // let a caller burn challenges without ever holding a credential (m9).
    const challenge = challengeIn(args.credential.client_data_json);
    const verified = refusable(() =>
      verifyRegistration(args.credential, {
        challenge,
        origin: originOf(stated.webui),
        rpId: rpIdOf(stated.webui),
      }),
    );
    // A key nothing can verify with is a credential that can never be used, and
    // finding that out at the person's next sign-in leaves a record nobody can
    // explain (M8).
    await refusableAsync(() => checkPublicKey(base64UrlDecode(verified.publicKey)));
    // Only now is the URL spent. It is good once, like the challenge, so
    // consuming it for a message that then failed to verify would let a caller
    // burn registrations without ever holding a credential (m9). What comes
    // back is the authenticated form of what was read above, and the relying
    // party the credential was actually checked against has to be the one the
    // issuer authorized.
    const claims = await this.#claimsOf(args);
    // The ceremony was verified against what the token said about itself, so
    // the two have to be the same two URLs the issuer authorized: a credential
    // checked against one web UI and written down under another would be a
    // record that says something nobody checked.
    if (claims.webui !== stated.webui || claims.endpoint !== stated.endpoint) {
      throw new OpError("auth_invalid", "登録 URL が名乗る宛先が一致しません");
    }
    if (this.deps.records.removed(claims.sub)) {
      throw new OpError("forbidden", `${claims.sub} は削除済みです`);
    }
    // The challenge is stated beside the credential when the page knows who
    // issued it. Where it is not, this instance is the only one that can spend
    // it — and one it does not hold is a challenge from somewhere it cannot
    // ask about (contract, `AuthRegisterArgs.challenge`).
    await this.#spendStated(challenge, args.challenge);
    if (this.deps.records.credential(verified.credentialId) !== undefined) {
      throw new OpError("auth_invalid", "この credential は既に登録されています");
    }
    const at = this.#now();
    const record: CredentialRecord = {
      kind: "credential",
      sub: claims.sub,
      credential_id: verified.credentialId,
      public_key: verified.publicKey,
      user_handle: claims.user_id,
      endpoint: claims.endpoint,
      webui: claims.webui,
      sign_count: verified.signCount,
      // What the authenticator said about backing this credential up, kept
      // because it decides what removing the line costs the person and nothing
      // else: neither flag is ever read to admit or refuse an exchange.
      backup_eligible: verified.backupEligible,
      backup_state: verified.backupState,
      ...(claims.issued_label === undefined ? {} : { issued_label: claims.issued_label }),
      ...(args.device_label === undefined ? {} : { device_label: args.device_label }),
      registered_at: at,
      ...(from.ip === undefined ? {} : { registered_ip: from.ip }),
      ...(from.userAgent === undefined ? {} : { registered_user_agent: from.userAgent }),
    };
    // The write is the last word on whether the person still exists: a removal
    // that landed while the issuer was being asked refuses the key, and a
    // session minted over a credential that was never written down would be the
    // removal not having happened (DR-0015 §2.5).
    const written = await this.deps.records.write(
      credentialKey(claims.sub, verified.credentialId),
      record,
      at,
    );
    if (!written) throw new OpError("forbidden", `${claims.sub} は削除済みです`);
    return this.mint(claims.sub, claims.webui);
  }

  /** What a registration URL authorized.
   *
   * Only its issuer can say, because only the issuer holds the secret that
   * signed it — and the six digits are held beside that secret. So the digits
   * travel there unjudged: an instance that decided them itself would let
   * somebody spread guesses across the mesh without any of them counting
   * against the URL (contract, `AuthResolveArgs`). Nothing is spent here.
   *
   * The claims come back from the issuer having been checked and consumed, and
   * everything after this — the WebAuthn verification, the record — is done by
   * whichever instance the browser actually reached (DR-0001 §2.6). */
  async #claimsOf(args: AuthRegisterArgs): Promise<RegisterClaims> {
    const stated = claimsOf(args.token);
    if (stated.iss === this.deps.self) return this.resolveRegistration(args.token, args.code);
    const answer = await this.#answerOf<AuthResolveResult>(
      stated.iss,
      "auth.resolve",
      { kind: "register", token: args.token, code: args.code } satisfies AuthResolveArgs,
      AuthResolveResultSchema,
    );
    if (answer.kind !== "register") {
      throw new OpError("auth_invalid", "登録 URL の発行者が別のものを答えました");
    }
    return answer.claims;
  }

  /** Check a registration URL against the secret that signed it, and spend it.
   *
   * Only the issuer can run this, which is what `auth.resolve` is for. The code
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
      // costs the whole registration rather than one attempt (DR-0001 §2.2).
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

  // --- assertion (DR-0001 §2.5) ---

  async assert(
    args: AuthAssertArgs,
    from: { ip?: string; userAgent?: string; path?: string; origin?: string | null } = {},
  ): Promise<MintedSession> {
    const record = this.deps.records.credential(args.credential.raw_id);
    if (record === undefined) {
      throw new OpError("auth_invalid", "この credential は登録されていません");
    }
    // A record from before a credential was held to a web UI names no page it
    // may be used from, and there is nothing to compare an origin with. It is
    // not a credential this contract can accept: the person registers again
    // (contract, DR-0029), and `docs/runbooks/passkeys-webui-binding.md` is how
    // the old one is taken off.
    const webui = webuiOf(record);
    // The endpoint the credential was registered for, and no other: two
    // instances may share a host, and this is what keeps one's credential from
    // being a way into the other (contract, `CredentialRecord.endpoint`).
    this.#servedHere(record.endpoint, from.path);
    // Which page the credential may be used from, held to the same value the
    // ceremony inside it is (contract, DR-0029).
    this.#cameFrom(webui, from.origin);
    // A resident credential answers with the handle it was created against,
    // which is how a person is found without having named an account. It is
    // held to what the registration settled: a handle naming somebody else is
    // an authenticator answering for a credential that is not the one this
    // record describes (contract, `RegisterClaims.user_id`).
    const handle = args.credential.user_handle;
    if (
      handle !== undefined &&
      !equalBytes(base64UrlDecode(handle), base64UrlDecode(record.user_handle))
    ) {
      throw new OpError("auth_invalid", "この assertion は別の利用者の handle を名乗っています");
    }
    // Verified before the challenge is spent, for the reason a registration is
    // (m9): a good-once value burnt by a message that never verified is a value
    // a caller can burn at will.
    const { signCount } = await refusableAsync(() =>
      verifyAssertion(
        args.credential,
        {
          publicKey: record.public_key,
          ...(record.sign_count === undefined ? {} : { signCount: record.sign_count }),
        },
        {
          challenge: args.challenge.challenge,
          origin: originOf(webui),
          rpIds: [rpIdOf(webui)],
        },
      ),
    );
    await this.#spendAnywhere(args.challenge);
    // Read again after the waits, and written on what stands now rather than on
    // what was read before them: a removal may have taken the credential, and
    // another assertion of the same credential may have finished first. The
    // counter is held to the standing record the way it was held to the one
    // read above — a reading that no longer advances it is the reading a copy
    // of the credential would make, whichever of the two arrived first — so
    // the earlier assertion cannot put its lower count back over the later
    // one's (DR-0015 §2.5).
    const standing = this.deps.records.credential(args.credential.raw_id);
    if (standing === undefined) {
      throw new OpError("auth_invalid", "この credential は登録されていません");
    }
    if (!advances(standing.sign_count, signCount)) {
      throw new OpError("auth_invalid", "the authenticator's counter did not advance");
    }
    const at = this.#now();
    const written = await this.deps.records.write(
      credentialKey(standing.sub, standing.credential_id),
      {
        ...standing,
        sign_count: signCount,
        last_used_at: at,
        ...(from.ip === undefined ? {} : { last_used_ip: from.ip }),
        ...(from.userAgent === undefined ? {} : { last_used_user_agent: from.userAgent }),
      },
      at,
    );
    if (!written) throw new OpError("forbidden", `${standing.sub} は削除済みです`);
    return this.mint(standing.sub, webuiOf(standing));
  }

  /** Refuse an exchange that arrived somewhere other than the endpoint it is
   * about.
   *
   * The path the request came in on is the carrier's observation, so a caller
   * cannot state it. A carrier that does not observe one — the mesh, where the
   * issuer is asked about a URL rather than posted to — states nothing and is
   * not held to a path it never had. */
  #servedHere(endpoint: Endpoint, path: string | undefined): void {
    if (path !== undefined && !servesPath(endpoint, path)) {
      throw new OpError("auth_invalid", `この要求は ${endpoint} 宛ではありません`);
    }
  }

  /** Refuse an exchange that came from a page other than the web UI it is
   * about.
   *
   * The `Origin` is the browser's own word for where the page was served from,
   * which its script cannot write, and it is compared with the origin read off
   * the web UI the claims or the record name. A request that states none is a
   * mismatch rather than an exemption: every gate has to be passed, and a
   * caller with nothing to compare has not passed this one (contract,
   * DR-0029).
   *
   * `undefined` is a carrier that observes no header at all — the mesh, where
   * the issuer is asked about a URL rather than posted to — and is not held to
   * one it never had. `null` is an HTTP request that carried none.
   */
  #cameFrom(webui: WebUi, origin: string | null | undefined): void {
    if (origin === undefined) return;
    if (origin !== originOf(webui)) {
      throw new OpError("auth_invalid", "この要求は登録された web UI の page からではありません");
    }
  }

  /** The origins whose pages may read these answers: the web UIs this
   * instance's credentials were made at, and the ones its outstanding
   * registration URLs name (contract, DR-0029).
   *
   * Nothing is configured and no list is kept: a registration is what adds an
   * origin and the removal of the last credential at one is what takes it away.
   * The URLs this instance holds are the other half, and the only half, of how
   * a first registration at a new web UI is answered at all — there is no
   * credential naming it yet. They are this instance's own knowledge and
   * travel nowhere, so a registration only completes where it was issued.
   *
   * Read by the HTTP carrier, which compares them whole. Not the relying party:
   * an RP ID is a domain, so a page at any host under it would be let in — and
   * the refresh route answers a cookie the browser attaches by domain, so a
   * sibling subdomain admitted here would read a person's access token.
   *
   * A credential with no web UI names no page and adds no origin; it is a
   * record this contract cannot accept, and the person registers again. */
  knownOrigins(): string[] {
    const origins = new Set<string>();
    for (const record of this.deps.records.credentials()) {
      if (record.webui !== undefined) origins.add(originOf(record.webui));
    }
    for (const held of this.#pending.values()) origins.add(originOf(held.claims.webui));
    return [...origins];
  }

  // --- tokens (DR-0001 §2.4) ---

  /** Make a family for this person, minted by this instance.
   *
   * The web UI comes from the credential that answered and is carried on the
   * family: a token says who the person is and nothing about what is holding
   * it, and this is what a connection presenting it is then held to (contract,
   * `TokenFamily.webui`). */
  async mint(sub: Subject, webui: WebUi): Promise<MintedSession> {
    const at = this.#now();
    const family: TokenFamily = {
      kind: "token_family",
      sub,
      iss: this.deps.self,
      webui,
      access: { value: token(), expires_at: at + ACCESS_TTL_MS },
      refresh: { value: token(), expires_at: at + REFRESH_TTL_MS },
    };
    const id = randomBytes(8).toString("hex");
    // A family the records refused is a person whose removal stands over the
    // key. Tokens answered for it would open connections nothing written down
    // admits, so the refusal is the answer.
    const written = await this.deps.records.write(familyKey(sub, id), family, at);
    if (!written) throw new OpError("forbidden", `${sub} は削除済みです`);
    return { session: { sub, access: family.access }, refresh: family.refresh, webui };
  }

  /** Rotate a family from a refresh token, wherever it was minted.
   *
   * A family is written by its `iss` alone, so a rotation that landed here for
   * a family minted elsewhere is carried there rather than done here — two
   * instances rotating one family in parallel would merge by last write and
   * read exactly like a stolen token being replayed (DR-0001 §2.4). */
  async refreshToken(
    value: Base64Url,
    from: RefreshFrom & { origin?: string | null } = {},
  ): Promise<MintedSession> {
    const held = this.deps.records.byRefresh(value);
    if (held === undefined) {
      // Not the standing generation, nor the one before it. Either it never was
      // one, or it is a value that has already been rotated away — which is a
      // token being reused, and fails the family it belongs to.
      await this.#refuseReuse(value);
      throw new OpError("auth_invalid", "この refresh token は使えません");
    }
    // The page asking is held to the family's own web UI, as the handshake
    // that presents its access token is (contract, DR-0029).
    const webui = webuiOf(held.body);
    this.#cameFrom(webui, from.origin);
    if (held.body.iss !== this.deps.self) {
      // What the carrier observed goes with the value: the person is at the
      // other end of this instance's connection and not the issuer's, so these
      // are only knowable here, and a rotation forwarded without them would be
      // remembered as a time and nothing else. The issuer writes them
      // unchecked, as it does the ones it observes itself (contract,
      // `AuthRotateArgs`).
      const answer = await this.#answerOf<AuthRotateResult>(
        held.body.iss,
        "auth.rotate",
        {
          refresh_token: value,
          ...(from.reason === undefined ? {} : { reason: from.reason }),
          ...(from.ip === undefined ? {} : { ip: from.ip }),
          ...(from.userAgent === undefined ? {} : { user_agent: from.userAgent }),
        } satisfies AuthRotateArgs,
        AuthRotateResultSchema,
      );
      return {
        session: { sub: answer.sub, access: answer.access },
        refresh: answer.refresh,
        webui,
      };
    }
    const rotated = await this.rotate(value, from);
    return {
      session: { sub: rotated.sub, access: rotated.access },
      refresh: rotated.refresh,
      webui,
    };
  }

  /** A value that works nowhere. If it was once some family's, the family is
   * failed — by its `iss`, which is the only instance that may write it.
   *
   * A family this instance minted is failed here. One minted elsewhere is
   * failed by asking that instance to rotate the value: it will find the same
   * thing this instance did, and fail its own family. Forwarding rather than
   * writing is what keeps the single writer single; an issuer that cannot be
   * reached leaves the refusal as the whole of the answer. */
  async #refuseReuse(value: Base64Url): Promise<void> {
    const owner = this.deps.records.owning(value, digestOf(value));
    if (owner === undefined) return;
    if (owner.body.iss === this.deps.self) {
      await this.#failReused(value);
      return;
    }
    try {
      await this.#atIssuer(owner.body.iss, "auth.rotate", {
        refresh_token: value,
      } satisfies AuthRotateArgs);
    } catch {
      // Whatever the issuer said, or that it said nothing: the caller is
      // refused either way, and this instance has no standing to fail a family
      // it does not write.
    }
  }

  /** Rotate a family this instance minted. The one writer's own operation, and
   * what `auth.rotate` runs on its behalf. */
  async rotate(value: Base64Url, from: RefreshFrom = {}): Promise<AuthRotateResult> {
    const held = this.deps.records.byRefresh(value);
    if (held === undefined) {
      await this.#failReused(value);
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
    // The refresh token rotates every time; the access token is the family's
    // one token and is shared by every page the person has open, so it is kept
    // until it is close enough to running out to be worth replacing.
    const access =
      held.body.access.expires_at - at >= ACCESS_KEEP_MS
        ? held.body.access
        : { value: token(), expires_at: at + ACCESS_TTL_MS };
    const rotated: TokenFamily = {
      kind: "token_family",
      sub: held.body.sub,
      iss: this.deps.self,
      webui: webuiOf(held.body),
      access,
      refresh: { value: token(), expires_at: at + REFRESH_TTL_MS },
      // Written by this instance because it is the family's `iss`, and only for
      // the rotation that just happened — the caller's word about why, and
      // where it was asked from, are a hint for the person reading their own
      // sessions back and are never checked (contract, `TokenFamily`).
      last_refresh: {
        at,
        ...(from.reason === undefined ? {} : { reason: from.reason }),
        ...(from.ip === undefined ? {} : { ip: from.ip }),
        ...(from.userAgent === undefined ? {} : { user_agent: from.userAgent }),
      },
      previous_refresh: { value: held.body.refresh.value, expires_at: at + PREVIOUS_GRACE_MS },
      // The value going out of service is remembered as a digest for as long as
      // it would have been accepted, so that presenting it later is recognised
      // as this family's token rather than as a stranger's. The digest travels
      // with the family, so the memory survives this instance restarting and
      // holds wherever the reused value is presented (contract, `TokenFamily`).
      retired: retire(held.body, at),
    };
    await this.deps.records.write(held.key, rotated, at);
    return { sub: rotated.sub, access: rotated.access, refresh: rotated.refresh };
  }

  /** A value that is nobody's standing token but was somebody's: the family it
   * belonged to is failed, because a token in use twice is a token that was
   * taken (DR-0001 §2.4).
   *
   * Recognised three ways: the standing refresh token past its expiry, the one
   * before it past its grace, and any generation this instance rotated away
   * while it has been running. A value older than what any of those covers
   * matches nothing and is refused as a stranger. */
  async #failReused(value: Base64Url): Promise<void> {
    const digest = digestOf(value);
    const now = this.#now();
    for (const held of this.deps.records.families()) {
      if (held.body.iss !== this.deps.self) continue;
      const before = held.body.previous_refresh;
      const stale =
        equalStrings(held.body.refresh.value, value) ||
        (before !== undefined && equalStrings(before.value, value)) ||
        (held.body.retired ?? []).some(
          (one) => one.expires_at > now && equalStrings(one.hash, digest),
        );
      if (!stale) continue;
      this.deps.log?.("a refresh token was reused after it was rotated away", {
        sub: held.body.sub,
      });
      await this.deps.records.fail(held.key);
      // The tokens are gone, and so is what they were holding open: a
      // connection that outlived the family it was admitted on would be the
      // stolen token still working.
      this.disconnect(held.body.sub);
    }
  }

  // --- connections (DR-0001 §2.5) ---

  /** Whether an access token opens a connection, until when, and from which
   * page.
   *
   * The web UI is stated so the handshake can hold the browser's `Origin` to
   * it: a token says who the person is and nothing about what is holding it,
   * and the family it belongs to is where that is written down (contract,
   * `TokenFamily.webui`). A family with none names no page, so nothing it
   * minted opens a connection. */
  admits(access: Base64Url): { sub: Subject; expiresAt: Timestamp; webui: WebUi } | undefined {
    const family = this.deps.records.byAccess(access);
    if (family === undefined || family.webui === undefined) return undefined;
    return { sub: family.sub, expiresAt: family.access.expires_at, webui: family.webui };
  }

  /** Take a connection an access token opened, and close it when the token runs
   * out. The client is expected to have extended it before then; one that did
   * not is the one this is for. */
  hold(conn: Requester, admitted: { sub: Subject; expiresAt: Timestamp }): void {
    const held: AuthorizedConn = { sub: admitted.sub, expiresAt: admitted.expiresAt };
    this.#authorized.set(conn, held);
    conn.onClose(() => {
      // The timer goes with the connection: a close scheduled for a socket that
      // is already gone is a handle kept for hours over nothing.
      clearTimeout(held.timer);
      this.#authorized.delete(conn);
    });
    this.#deadline(conn, held);
  }

  #deadline(conn: Requester, held: AuthorizedConn): void {
    held.timer = setTimeout(
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
    held.timer.unref?.();
  }

  /** When this connection's authorization runs out, for `hello` to state. */
  expiresAt(conn: Requester): Timestamp | undefined {
    return this.#authorized.get(conn)?.expiresAt;
  }

  /** Extend a live connection with a token got from `/auth/refresh` (DR-0001 §2.5). */
  extend(conn: Requester, args: AuthExtendArgs): AuthExtendResult {
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

  // --- the rate limit the unauthenticated routes share (DR-0001 §2.4) ---

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
    "auth.extend": (input: HandlerInput): AuthExtendResult =>
      auth.extend(input.conn, input.args as unknown as AuthExtendArgs),
    "auth.resolve": (input: HandlerInput): AuthResolveResult => {
      const args = input.args as unknown as AuthResolveArgs;
      if (args.kind === "challenge") {
        auth.spend(args.challenge);
        return { kind: "challenge" };
      }
      // The digits arrive unjudged from wherever the browser landed, and are
      // checked here — this is the instance holding both the secret that signed
      // the URL and the count of tries against it (DR-0001 §2.2).
      return { kind: "register", claims: auth.resolveRegistration(args.token, args.code) };
    },
    "auth.rotate": (input: HandlerInput): Promise<AuthRotateResult> => {
      const args = input.args as unknown as AuthRotateArgs;
      // The receiving instance's account of the person, taken as stated: it is
      // the only one that saw them, and `last_refresh` is a hint nothing is
      // decided by (contract, `AuthRotateArgs`).
      return auth.rotate(args.refresh_token, {
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        ...(args.ip === undefined ? {} : { ip: args.ip }),
        ...(args.user_agent === undefined ? {} : { userAgent: args.user_agent }),
      });
    },
  };
}

/** Run a verification, and answer a refusal in the contract's vocabulary.
 *
 * Everything these routes are handed is attacker-supplied, and the libraries
 * they go through say so in their own languages: a `WebAuthnError` from the
 * checks here, a `CborError` from a malformed structure, a `DOMException` from
 * WebCrypto refusing a key, a `RangeError` from a length that does not fit.
 * They are one answer to the caller — the message was not valid — and letting
 * any of them out as it is would answer `internal_error` for a bad request
 * (M6). */
function refusable<T>(run: () => T): T {
  try {
    return run();
  } catch (cause) {
    throw asRefusal(cause);
  }
}

async function refusableAsync<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw asRefusal(cause);
  }
}

function asRefusal(cause: unknown): unknown {
  if (cause instanceof OpError) return cause;
  if (
    cause instanceof WebAuthnError ||
    cause instanceof CborError ||
    cause instanceof RangeError ||
    (typeof DOMException !== "undefined" && cause instanceof DOMException)
  ) {
    return new OpError("auth_invalid", cause.message);
  }
  return cause;
}

/** What a family remembers of the generations before the one it still names.
 *
 * The outgoing refresh token joins the list, and anything whose own expiry has
 * passed leaves it: past that instant, remembering the value refuses nothing
 * its expiry would not have refused anyway, so keeping it is only growth. */
function retire(family: TokenFamily, now: Timestamp): { hash: string; expires_at: Timestamp }[] {
  return [
    ...(family.retired ?? []).filter((one) => one.expires_at > now),
    { hash: digestOf(family.refresh.value), expires_at: family.refresh.expires_at },
  ];
}

/** Whether a counter reading moves the record forward.
 *
 * The rule the verification applies (L2 §7.2, `verifyAssertion`): a synced
 * passkey reports zero forever, and an authenticator that counts only counts
 * up, so once a non-zero reading is on the record every later one has to be
 * higher. Applied again here, to the record as it stands after the waits. */
function advances(recorded: number | undefined, reading: number): boolean {
  const last = recorded ?? 0;
  return last === 0 || reading > last;
}

/** The digest a retired token is remembered by. */
function digestOf(value: Base64Url): string {
  return createHash("sha256").update(value).digest("hex");
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
 * needs (DR-0001 §2.2). */
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
  // The two URLs are read before anything has vouched for them — an origin and
  // a relying party are derived from one of them to verify the ceremony with —
  // so they are held to the contract's spelling here rather than handed to a
  // URL parser that would fault on a caller's string.
  for (const [name, schema, url] of [
    ["endpoint", EndpointSchema, held.endpoint],
    ["webui", WebUiSchema, held.webui],
  ] as const) {
    if (validationErrors(schema, url).length > 0) {
      throw new OpError("auth_invalid", `登録 URL の token の ${name} が base URL ではありません`);
    }
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

/** Whether a request that arrived at this path was made to this endpoint.
 *
 * The endpoint's own path, compared exactly: `https://h/` and
 * `https://h/personal/` are two instances that may share a host, so a
 * credential registered for one is not a way into the other (contract,
 * `CredentialRecord.endpoint`). The prefix a proxy leaves on the front is what
 * the carrier already stripped down to when it found the route.
 *
 * Whether the origin matches is asked separately: the two together are what
 * bind a credential to one instance. */
export function servesPath(endpoint: Endpoint, path: string): boolean {
  return new URL(endpoint).pathname === path;
}

/** The web UI a credential or a family names.
 *
 * A record written before credentials were held to a web UI has none, and
 * there is no value to compare an origin or a relying party with. The contract
 * has no migration for it: the record is invalid and the person registers
 * again (DR-0029). */
function webuiOf(held: { webui?: WebUi }): WebUi {
  if (held.webui === undefined) {
    throw new OpError(
      "auth_invalid",
      "この登録は web UI を持たないので使えません。登録し直してください",
    );
  }
  return held.webui;
}
