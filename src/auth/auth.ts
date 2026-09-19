import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import type {
  AssertionCredential,
  AuthAccountReadResult,
  AuthAssertArgs,
  AuthChallenge,
  AuthChallengeArgs,
  AuthChallengeResult,
  AuthCredentialRemoveArgs,
  AuthEnrollArgs,
  AuthExtendArgs,
  AuthExtendResult,
  AuthOwnershipRemoveArgs,
  AuthRecord,
  AuthRefreshReason,
  AuthRegisterArgs,
  AuthResolveArgs,
  AuthResolveResult,
  AuthSession,
  Base64Url,
  CredentialRecord,
  EnrollClaims,
  Endpoint,
  GrantedBy,
  InstanceId,
  InstanceInfo,
  Origin,
  Timestamp,
  TokenFamily,
  UserId,
  UserRecord,
} from "@ccmsg/protocol";
import {
  AUTH_CHALLENGE_TTL_MS,
  AuthResolveResult as AuthResolveResultSchema,
  Endpoint as EndpointSchema,
  EnrollClaims as EnrollClaimsSchema,
  Origin as OriginSchema,
  REGISTER_TTL_MS,
  UserId as UserIdSchema,
  validationErrors,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError, type Requester } from "../dispatch/index.ts";
import { AuthRecords, credentialKey, familyKey, ownershipKey, userKey } from "./records.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  checkPublicKey,
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

/** How many times a six-digit code may be got wrong before the enrolment URL
 * is spent.
 *
 * Five, because the code is what stands between a leaked URL and an
 * enrolment: a million codes and five tries is a chance no one plays for,
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

/** What a person is called where nobody has said.
 *
 * A passkey manager stores the account name the ceremony was given and shows it
 * wherever the key is listed, so something has to be there — and a person's id
 * is sixteen random bytes, which is the one thing it must not be. Short, and
 * about the service rather than about them, because that is all that is known
 * at the moment the URL is made; `user rename` is how it becomes their own. */
export const PERSON_LABEL = "ccmsg";

/** The fragment an enrolment URL carries what it authorizes in.
 *
 * One name for both purposes, because the claims say which of the two this is
 * and a page that read the purpose off the fragment as well would have two
 * answers able to disagree. A fragment rather than a query: it is never sent to
 * a server, so the token reaches the page and nothing else. */
export const ENROLL_FRAGMENT = "enroll";

/** One enrolment URL that has been issued and not yet spent.
 *
 * Everything here dies with the process. The secret signs one URL and nothing
 * else, so there is no key to keep, rotate or protect — a restart loses it and
 * the remedy is to issue another URL (DR-0001 §2.2). */
interface Pending {
  readonly claims: EnrollClaims;
  readonly secret: Buffer;
  readonly code: string;
  attempts: number;
}

/** One challenge this instance issued, good once. */
interface Issued {
  readonly expiresAt: Timestamp;
}

/** What a person's connection carries once an access token opened it. */
export interface AuthorizedConn {
  readonly user: UserId;
  /** The passkey this session was opened with, where this instance saw it
   * happen. What `auth_in_use` is decided by, and memory alone: it is a fact
   * about a live session rather than about the person, so nothing replicates it
   * and a restart leaves the question unanswerable — which is answered as "not
   * in use", the refusal being a courtesy rather than a boundary. */
  readonly credential?: Base64Url;
  expiresAt: Timestamp;
  /** The close scheduled for the deadline, cleared when the connection goes so
   * a departed connection leaves no timer behind. */
  timer?: ReturnType<typeof setTimeout>;
}

export interface AuthDeps {
  readonly self: InstanceId;
  readonly records: AuthRecords;
  /** Where this instance is reached, which an enrolment URL names as the
   * address the page posts to when the operator names none. */
  readonly endpoint: () => Endpoint | undefined;
  /** The instance's name as a person operates it, for the terminal that issued
   * a URL to say which instance it was. */
  readonly unit: string;
  /** The mesh as this instance sees it: who the peers are, which is what
   * granting every peer at once walks, and where each is reached, which is what
   * a person reading their own instances back is shown. */
  readonly instances?: () => InstanceInfo[];
  /** Ask another instance the one op only its issuer can answer. Absent on an
   * instance with no mesh, where an issuer that is not us is an issuer that
   * cannot be reached. */
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
  /** The origin the family is held to, which is what the carrier reads to know
   * whether its cookie crosses sites (DR-0028). */
  readonly origin: Origin;
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

/** What an enrolment URL is, as the command that made it prints it. */
export interface IssuedEnrolment {
  /** Which of the two this URL authorizes: making the person, or handing them
   * this instance. */
  readonly purpose: EnrollClaims["purpose"];
  readonly url: string;
  readonly code: string;
  /** The person this URL is for. Stated for `create_user`, where the issuer
   * settles the handle the authenticator will keep; absent for `add_owner`,
   * where who arrives is what the assertion says. */
  readonly user?: UserId;
  readonly expires_at: Timestamp;
  readonly instance: InstanceId;
  readonly origin: Origin;
  readonly endpoint: Endpoint;
  /** The relying party the page will create or use the credential under, which
   * is the origin's host. Stated so the command can show what the browser will
   * be asked for; it is derived and is kept nowhere. */
  readonly rp_id: string;
  /** The instances this URL hands over, which is what `--all` widened. They
   * are written when the ceremony succeeds and not before, so a URL nobody
   * spends leaves nothing behind. */
  readonly instances: InstanceId[];
  /** What the authenticator will be told to call the account, which the person
   * may still change on the form. */
  readonly display_name?: string;
}

/** The person's authentication: the enrolment URLs this instance issued, the
 * challenges it holds, and the tokens it minted.
 *
 * What is written down is the records; everything here is memory, and every
 * one of those is short-lived by design. */
export class Auth {
  readonly #pending = new Map<string, Pending>();
  readonly #challenges = new Map<Base64Url, Issued>();
  readonly #authorized = new Map<Requester, AuthorizedConn>();
  /** Which passkey each family was opened with, for as long as this process
   * runs (`AuthorizedConn.credential`). */
  readonly #openedWith = new Map<string, Base64Url>();
  #window = 0;
  #served = 0;

  constructor(private readonly deps: AuthDeps) {}

  get records(): AuthRecords {
    return this.deps.records;
  }

  get self(): InstanceId {
    return this.deps.self;
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

  // --- issuing an enrolment URL ---

  /** Make one enrolment URL and the code that goes with it, and write the
   * grantings it comes with.
   *
   * The two halves reach the browser by different routes: the URL is carried
   * there by whoever was given it, and the code is only ever shown on the
   * terminal this ran on. Somebody holding the URL alone cannot spend it.
   *
   * The instances the URL hands over are settled here and carried in its
   * claims; the grantings themselves are written by whichever instance the
   * ceremony lands on, once it succeeds. Writing them now would leave a
   * granting naming somebody no user record answers for behind every URL that
   * was never spent — inert, since nothing could authenticate as them, and
   * indistinguishable from one that means something. */
  async issue(options: {
    readonly purpose: EnrollClaims["purpose"];
    readonly origin?: Origin;
    readonly endpoint?: Endpoint;
    /** The administrator's note about who this URL was handed to, kept on the
     * credential and shown to nobody but whoever reads the list back. */
    readonly label?: string;
    /** What to suggest the account be called, which the person may change on
     * the form. Apart from `label` because one value doing both would show an
     * administrator's private note to the person as their own name (contract,
     * DR-0030 §4). */
    readonly name?: string;
    /** The person a `create_user` URL is for. Stated to add a passkey to
     * somebody who already exists — the handle is theirs and the credential
     * count is what grows — and left out to make a new person. */
    readonly user?: UserId;
    readonly ttl?: number;
    /** Grant every peer this instance knows of, not only this one. */
    readonly all?: boolean;
  }): Promise<IssuedEnrolment> {
    const endpoint = options.endpoint ?? this.deps.endpoint();
    if (endpoint === undefined) {
      throw new OpError(
        "invalid_args",
        "この instance には endpoint が無いので、--endpoint で page の送り先を渡してください",
      );
    }
    // The address the page posts to. It is not compared with anything by
    // whoever receives the answer (contract, `EnrollClaims.endpoint`), so what
    // is checked here is only that it is an address at all — a string that is
    // not one would be a URL the page could not use.
    this.#spelled("endpoint", endpoint, EndpointSchema);
    // Where the person is sent, which is the one place the ceremony may be
    // held. It defaults to this endpoint's own origin, an instance serving its
    // own web UI being the ordinary case; a UI published anywhere else is named
    // here. An endpoint no ceremony could run at — a bare address, a host
    // nothing calls trustworthy — has no origin to fall back on, and the
    // operator names one.
    const origin = options.origin ?? originOf(endpoint);
    if (origin === undefined) {
      throw new OpError(
        "invalid_args",
        `${endpoint} は passkey を作れる origin ではないので、--origin で page の origin を渡してください`,
      );
    }
    this.#spelled("origin", origin, OriginSchema);
    const at = this.#now();
    // What the page will call this account in the authenticator. A passkey
    // manager keeps the name it was given at creation and shows it in its own
    // list, so a URL that carried none would put a random handle in front of
    // the person every time they signed in (`PERSON_LABEL`). For somebody who
    // already exists it is the name they read themselves by, so a second key
    // joins the same account; for a new person it is what the operator
    // suggested, and the person may still say otherwise on the form.
    const known = options.user === undefined ? undefined : this.deps.records.user(options.user);
    const displayName = known?.display_name ?? options.name;
    const commonFields = {
      iss: this.deps.self,
      instance: this.deps.self,
      origin,
      endpoint,
      expires_at: at + (options.ttl ?? REGISTER_TTL_MS),
      jti: randomBytes(16).toString("base64url"),
      ...(options.label === undefined ? {} : { issued_label: options.label }),
      ...(displayName === undefined ? {} : { display_name: displayName }),
    };
    // Which instances this URL hands over. Decided here, at the terminal, where
    // "the peers this instance knows of" is a question a person can see the
    // answer to; carried in the claims because behind a load balancer the
    // ceremony lands wherever it lands, and an instance writing the grantings it
    // happened to know of would answer a different question than the one that
    // was asked (contract, `EnrollClaims.instances`).
    const instances = this.targets(options.all === true);
    const common = { ...commonFields, ...(instances.length > 1 ? { instances } : {}) };
    const claims: EnrollClaims =
      options.purpose === "create_user"
        ? { ...common, purpose: "create_user", user: options.user ?? newUserId() }
        : { ...common, purpose: "add_owner" };
    const secret = randomBytes(32);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.#pending.set(claims.jti, { claims, secret, code, attempts: 0 });
    return {
      purpose: claims.purpose,
      url: `${origin}/#${ENROLL_FRAGMENT}=${sign(claims, secret)}`,
      code,
      ...(claims.purpose === "create_user" ? { user: claims.user } : {}),
      expires_at: claims.expires_at,
      instance: claims.instance,
      origin,
      endpoint,
      rp_id: hostOf(origin),
      instances,
      ...(displayName === undefined ? {} : { display_name: displayName }),
    };
  }

  /** Read one value an operator typed, in the contract's own spelling.
   *
   * An operator types these, so they are read here rather than trusted: a value
   * that is not what the contract spells would be written into a record and be
   * compared, forever after, against something that can never match it. */
  #spelled(name: string, value: string, schema: Parameters<typeof validationErrors>[0]): void {
    const problems = validationErrors(schema, value);
    if (problems.length === 0) return;
    throw new OpError(
      "invalid_args",
      `${name} の綴りが契約と合いません (${value}): ${problems.join("; ")}`,
    );
  }

  /** The instances a granting is written for: this one, and every peer this
   * instance knows of when `--all` asked.
   *
   * Peers are written from here because they are the same kind of thing this
   * instance is — each trusts the others equally — and because a new instance
   * would otherwise need somebody to walk to it (contract, `OwnershipRecord`). */
  targets(all: boolean): InstanceId[] {
    if (!all) return [this.deps.self];
    const known = new Set<InstanceId>([this.deps.self]);
    for (const row of this.deps.instances?.() ?? []) {
      if (row.id !== undefined) known.add(row.id);
    }
    return [...known];
  }

  /** Hand one person a set of instances, one granting each. Already owning one
   * is not an error and writes nothing: ownership is held or not held, and a
   * second granting of the same thing widens nothing. */
  async grant(
    user: UserId,
    instances: readonly InstanceId[],
    by: GrantedBy,
  ): Promise<InstanceId[]> {
    const written: InstanceId[] = [];
    const at = this.#now();
    for (const instance of instances) {
      if (this.deps.records.owns(user, instance)) continue;
      const grant = base64UrlEncode(randomBytes(16));
      const body = {
        kind: "ownership" as const,
        user,
        instance,
        grant,
        granted_at: at,
        granted_by: by,
      };
      if (await this.deps.records.write(ownershipKey(instance, user, grant), body, at)) {
        written.push(instance);
      }
    }
    return written;
  }

  /** Let one instance go: every granting of it to this person is marked, there
   * being no shape for ending one of two grantings of the same thing (contract,
   * `auth.ownership.remove`). */
  async revoke(user: UserId, instance: InstanceId): Promise<number> {
    const grants = this.deps.records.grantsOf(user, instance);
    if (grants.length === 0) {
      throw new OpError("not_found", `${user} は ${instance} を持っていません`);
    }
    for (const held of grants) await this.deps.records.erase(held.key);
    if (instance === this.deps.self) this.disconnect(user);
    return grants.length;
  }

  /** The people this instance holds, newest first. */
  users(): UserRecord[] {
    return this.deps.records.users().sort((left, right) => right.created_at - left.created_at);
  }

  /** The credentials a person may read back, newest registration first. */
  credentials(user?: UserId): CredentialRecord[] {
    return this.deps.records
      .credentials()
      .filter((record) => user === undefined || record.user === user)
      .sort((left, right) => right.registered_at - left.registered_at);
  }

  /** What one person is: who they are, what answers for them, and what they own
   * (contract, `auth.account.read`). */
  account(user: UserId): AuthAccountReadResult {
    const held = this.deps.records.user(user);
    if (held === undefined) throw new OpError("not_found", `${user} は居ません`);
    const endpoints = new Map<InstanceId, Endpoint>();
    for (const row of this.deps.instances?.() ?? []) {
      if (row.id !== undefined && row.endpoint !== undefined) endpoints.set(row.id, row.endpoint);
    }
    const mine = this.deps.endpoint();
    if (mine !== undefined) endpoints.set(this.deps.self, mine);
    return {
      user: held,
      credentials: this.credentials(user).map(({ public_key: _key, ...rest }) => rest),
      instances: this.deps.records
        .ownerships()
        .filter((record) => record.user === user)
        .sort((left, right) => left.granted_at - right.granted_at)
        .map((record) => {
          const endpoint = endpoints.get(record.instance);
          return {
            instance: record.instance,
            ...(endpoint === undefined ? {} : { endpoint }),
            granted_at: record.granted_at,
            ...(record.granted_by === undefined ? {} : { granted_by: record.granted_by }),
          };
        }),
    };
  }

  /** Give one person a name they read themselves by. It authenticates nothing
   * (contract, `UserRecord.display_name`). */
  async rename(user: UserId, name: string): Promise<UserRecord> {
    const held = this.deps.records.user(user);
    if (held === undefined) throw new OpError("not_found", `${user} は居ません`);
    const renamed: UserRecord = { ...held, display_name: name };
    if (!(await this.deps.records.write(userKey(user), renamed))) {
      throw new OpError("forbidden", `${user} は削除済みです`);
    }
    return renamed;
  }

  /** Take one passkey off. The origin it was made at leaves the allowed set
   * with the last credential naming it, which is the only way an origin ever
   * leaves (contract, `auth.credential.remove`). */
  async removeCredential(user: UserId, credentialId: Base64Url): Promise<void> {
    const held = this.deps.records.credential(credentialId);
    if (held === undefined || held.user !== user) {
      throw new OpError("not_found", "その passkey はありません");
    }
    await this.deps.records.erase(credentialKey(held.credential_id));
  }

  /** Close every connection one person holds here.
   *
   * The other half of a revocation, and the half that has to run whoever
   * decided it: a granting marked at a peer revokes the same person here, and a
   * connection left open on one is the revocation not having happened. Failing
   * a family reaches this the same way. */
  disconnect(user: UserId): number {
    let closed = 0;
    for (const [conn, held] of this.#authorized) {
      if (held.user !== user) continue;
      clearTimeout(held.timer);
      this.#authorized.delete(conn);
      conn.close();
      closed += 1;
    }
    return closed;
  }

  /** Take what a peer wrote on `auth.records`, and act on the removals in it.
   *
   * **Any mark naming a person ends the connections they hold here**, whether
   * it took a granting, a passkey or a family, and whether or not they still
   * own this instance. A family is failed where the replay was seen, and behind
   * a load balancer that is not where the connections are: leaving them open
   * because the person is still an owner would make replay detection work on
   * one instance and not on its peers, which is the whole of what replicating
   * the mark is for. Signing in again is what a person whose mark was not about
   * them does, and it costs one verification.
   *
   * The sweep afterwards is the other direction: a granting taken away
   * somewhere leaves connections here that no record admits any more, including
   * ones whose own mark never arrived. */
  async merge(records: readonly AuthRecord[]): Promise<void> {
    const { revoked } = await this.deps.records.merge(records);
    for (const user of new Set(revoked)) this.disconnect(user);
    for (const [conn, held] of this.#authorized) {
      if (this.deps.records.owns(held.user, this.deps.self)) continue;
      clearTimeout(held.timer);
      this.#authorized.delete(conn);
      conn.close();
    }
    // A family a peer failed is one nothing here may still name.
    for (const key of this.#openedWith.keys()) {
      if (this.deps.records.removed(key)) this.#openedWith.delete(key);
    }
  }

  // --- challenges ---

  /** Hand out a challenge, and — for a page opened from an enrolment URL —
   * refuse before the person is shown anything if that URL can no longer be
   * spent (contract, `AuthChallengeArgs`). */
  async challenge(args: AuthChallengeArgs = {}): Promise<AuthChallengeResult> {
    if (args.token !== undefined) await this.#aliveEnrolment(args.token);
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
   * caller says issued it (behind a load balancer either may be reached). */
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

  // --- making a user, and adding an instance to one ---

  /** Verify a registration, write the person and the passkey down.
   *
   * The enrolment URL is checked where its secret is, which may be another
   * instance; everything else — the WebAuthn verification, the records — is
   * done here, by whoever the browser reached (contract, DR-0030 §4). */
  async register(
    args: AuthRegisterArgs,
    from: { ip?: string; userAgent?: string; origin?: string | null } = {},
  ): Promise<MintedSession> {
    // What the URL says about itself, before anything has vouched for it. It is
    // read to know which origin the credential should have been made at;
    // nothing is decided by it, because the same fields come back authenticated
    // below and the two are held to each other.
    const stated = claimsOf(args.token);
    if (stated.purpose !== "create_user") {
      throw new OpError("auth_invalid", "この登録 URL は passkey を作るためのものではありません");
    }
    // The page has to be the one the URL sends people to. What the carrier
    // observed of it is held to the same value the ceremony is, and a request
    // that states no origin has not passed this gate.
    this.#cameFrom(stated.origin, from.origin);
    // What the page answered, verified before anything is spent: a challenge is
    // good once, so consuming it for a message that then fails to verify would
    // let a caller burn challenges without ever holding a credential (m9).
    const challenge = challengeIn(args.credential.client_data_json);
    const verified = refusable(() =>
      verifyRegistration(args.credential, {
        challenge,
        origin: stated.origin,
        rpId: hostOf(stated.origin),
      }),
    );
    // A key nothing can verify with is a credential that can never be used, and
    // finding that out at the person's next sign-in leaves a record nobody can
    // explain (M8).
    await refusableAsync(() => checkPublicKey(base64UrlDecode(verified.publicKey)));
    // Only now is the URL spent. It is good once, like the challenge, so
    // consuming it for a message that then failed to verify would let a caller
    // burn enrolments without ever holding a credential (m9).
    const claims = await this.#claimsOf(args.token, args.code);
    if (claims.purpose !== "create_user" || claims.origin !== stated.origin) {
      throw new OpError("auth_invalid", "登録 URL が名乗る内容が一致しません");
    }
    await this.#spendStated(challenge, args.challenge);
    if (this.deps.records.credential(verified.credentialId) !== undefined) {
      throw new OpError("auth_invalid", "この credential は既に登録されています");
    }
    const at = this.#now();
    // The person, written once. A URL naming somebody who already exists is a
    // passkey being added to them, and their record stands as it is — the name
    // they gave themselves and the instant they were made are theirs.
    // Adding a passkey to somebody who exists does not rename them: the account
    // it joins is one they have already named.
    if (this.deps.records.user(claims.user) === undefined) {
      const user: UserRecord = {
        kind: "user",
        user: claims.user,
        // What the person settled on the form, the URL's starting point where
        // they said nothing, and the short default where nobody did.
        display_name: args.display_name ?? claims.display_name ?? PERSON_LABEL,
        created_at: at,
      };
      if (!(await this.deps.records.write(userKey(claims.user), user, at))) {
        throw new OpError("forbidden", `${claims.user} は削除済みです`);
      }
    }
    const record: CredentialRecord = {
      kind: "credential",
      user: claims.user,
      credential_id: verified.credentialId,
      public_key: verified.publicKey,
      origin: claims.origin,
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
    // The write is the last word on whether the passkey stands: a removal that
    // landed while the issuer was being asked refuses the key, and a session
    // minted over a credential that was never written down would be the removal
    // not having happened (DR-0015 §2.5).
    if (!(await this.deps.records.write(credentialKey(verified.credentialId), record, at))) {
      throw new OpError("forbidden", "この credential は削除済みです");
    }
    // The instances the URL handed over, written now that the ceremony stands.
    // `granted_by` is the instance that issued the URL rather than this one:
    // what a reader of the list wants to know is where the decision was made,
    // and behind a load balancer this instance is only where the answer landed.
    await this.grant(claims.user, handedOver(claims), {
      kind: "instance",
      instance: claims.iss,
    });
    return this.mint(claims.user, claims.origin, verified.credentialId);
  }

  /** Take one instance as a person's own, on the strength of a passkey they
   * already hold and the six digits shown at that instance's terminal.
   *
   * Already owning it is a success that writes nothing: ownership is held or
   * not held, and refusing would read to the person as a mistyped code
   * (contract, DR-0030 §4). */
  async enroll(
    args: AuthEnrollArgs,
    from: { ip?: string; userAgent?: string; origin?: string | null } = {},
  ): Promise<MintedSession> {
    const stated = claimsOf(args.token);
    if (stated.purpose !== "add_owner") {
      throw new OpError("auth_invalid", "この URL は instance を足すためのものではありません");
    }
    // Where the person was sent, which is what the browser has to say it came
    // from. The ceremony itself is held to the credential's own origin below:
    // an assertion happens where the passkey lives (contract, DR-0030 §9).
    this.#cameFrom(stated.origin, from.origin);
    const { record, signCount } = await this.#asserted(args.credential, args.challenge.challenge);
    const claims = await this.#claimsOf(args.token, args.code);
    if (claims.purpose !== "add_owner" || claims.origin !== stated.origin) {
      throw new OpError("auth_invalid", "この URL が名乗る内容が一致しません");
    }
    await this.#spendAnywhere(args.challenge);
    await this.#used(record, signCount, from);
    // The instance that issued the URL, as a registration's is: what a reader
    // of the list wants to know is where the decision was made, and behind a
    // load balancer this instance is only where the answer landed.
    await this.grant(record.user, handedOver(claims), { kind: "instance", instance: claims.iss });
    return this.mint(record.user, record.origin, record.credential_id);
  }

  /** What an enrolment URL authorized.
   *
   * Only its issuer can say, because only the issuer holds the secret that
   * signed it — and the six digits are held beside that secret. So the digits
   * travel there unjudged: an instance that decided them itself would let
   * somebody spread guesses across the mesh without any of them counting
   * against the URL (contract, `AuthResolveArgs`). Nothing is spent here.
   *
   * The claims come back from the issuer having been checked and consumed, and
   * everything after this — the WebAuthn verification, the records — is done by
   * whichever instance the browser actually reached. */
  async #claimsOf(token: string, code: string): Promise<EnrollClaims> {
    const stated = claimsOf(token);
    if (stated.iss === this.deps.self) return this.resolveEnrolment(token, code);
    const answer = await this.#answerOf<AuthResolveResult>(
      stated.iss,
      "auth.resolve",
      { kind: "claims", token, code } satisfies AuthResolveArgs,
      AuthResolveResultSchema,
    );
    if (answer.kind !== "claims") {
      throw new OpError("auth_invalid", "この URL の発行者が別のものを答えました");
    }
    return answer.claims;
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

  /** Whether an enrolment URL could still be spent, asked where its secret is.
   *
   * Every way of failing is the one refusal: a URL already spent, one past its
   * window, one whose issuer is nobody this instance can reach, and a token
   * that is not one at all. Telling them apart would tell somebody holding a
   * URL they guessed at that it had once been real (contract, DR-0030 §4). The
   * reason goes to the log, where the operator rather than the caller reads it.
   *
   * Nothing is spent and no attempt is counted: this is asked when a page is
   * opened, and an enrolment that a page could exhaust by being opened would
   * be one a link in a chat window could burn. */
  async #aliveEnrolment(token: string): Promise<void> {
    try {
      const stated = claimsOf(token);
      if (stated.iss === this.deps.self) {
        this.checkEnrolment(token);
        return;
      }
      const answer = await this.#answerOf<AuthResolveResult>(
        stated.iss,
        "auth.resolve",
        { kind: "alive", token } satisfies AuthResolveArgs,
        AuthResolveResultSchema,
      );
      if (answer.kind !== "alive") {
        throw new OpError("auth_invalid", "この URL の発行者が別のものを答えました");
      }
    } catch (cause) {
      this.deps.log?.("an enrolment URL was opened and is not one that could be spent", {
        error: String(cause),
      });
      throw new OpError("auth_invalid", "この URL は使えません。再発行してください");
    }
  }

  /** Check an enrolment URL without spending it: it is held here, its window
   * has not passed, and the signature is the one this instance's secret makes.
   *
   * The digits are not among them — there is nothing here for them to
   * authorize, and counting an attempt for a question that spends nothing
   * would put the URL's one defence in reach of whoever can open the page. */
  checkEnrolment(token: string): void {
    const stated = claimsOf(token);
    const held = this.#pending.get(stated.jti);
    if (held === undefined) {
      throw new OpError("auth_expired", "この URL は使えません。再発行してください");
    }
    if (held.claims.expires_at <= this.#now()) {
      this.#pending.delete(stated.jti);
      throw new OpError("auth_expired", "この URL は期限切れです。再発行してください");
    }
    if (!equalStrings(token, sign(held.claims, held.secret))) {
      throw new OpError("auth_invalid", "この URL の署名が合いません");
    }
  }

  /** Check an enrolment URL against the secret that signed it, and spend it.
   *
   * Only the issuer can run this, which is what `auth.resolve` is for. The code
   * is checked here too: it was issued with the secret and is held beside it,
   * and letting another instance check it would be putting the one defence
   * against a leaked URL somewhere the URL's holder could reach. */
  resolveEnrolment(token: string, code?: string): EnrollClaims {
    const stated = claimsOf(token);
    const held = this.#pending.get(stated.jti);
    if (held === undefined) {
      throw new OpError("auth_expired", "この URL は使えません。再発行してください");
    }
    if (held.claims.expires_at <= this.#now()) {
      this.#pending.delete(stated.jti);
      throw new OpError("auth_expired", "この URL は期限切れです。再発行してください");
    }
    if (!equalStrings(token, sign(held.claims, held.secret))) {
      throw new OpError("auth_invalid", "この URL の署名が合いません");
    }
    if (code === undefined || !equalStrings(code, held.code)) {
      held.attempts += 1;
      // The URL itself is spent once the tries are gone, so guessing the code
      // costs the whole enrolment rather than one attempt (DR-0001 §2.2).
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

  // --- assertion ---

  async assert(
    args: AuthAssertArgs,
    from: { ip?: string; userAgent?: string; origin?: string | null } = {},
  ): Promise<MintedSession> {
    const { record, signCount } = await this.#asserted(
      args.credential,
      args.challenge.challenge,
      from.origin,
    );
    // Which instance the person reached is not compared with anything; whether
    // they own it is the whole of what admits them (contract, DR-0030 §3).
    if (!this.deps.records.owns(record.user, this.deps.self)) {
      this.#log("a person asserted at an instance they do not own", { user: record.user });
      throw refused();
    }
    await this.#spendAnywhere(args.challenge);
    await this.#used(record, signCount, from);
    return this.mint(record.user, record.origin, record.credential_id);
  }

  /** Verify one assertion against the credential it names, without spending
   * anything. Shared by signing in and by taking an instance, which differ in
   * what they do with the answer rather than in how it is checked.
   *
   * `origin` is what the carrier observed, held to the credential's own: an
   * assertion happens at the page the passkey was made at. It is left out where
   * the caller has already compared something else (an enrolment holds the
   * header to the URL's origin). */
  async #asserted(
    credential: AssertionCredential,
    challenge: Base64Url,
    origin?: string | null,
  ): Promise<{ record: CredentialRecord; signCount: number }> {
    const record = this.deps.records.credential(credential.raw_id);
    if (record === undefined) {
      throw new OpError("auth_invalid", "この credential は登録されていません");
    }
    if (origin !== undefined) this.#cameFrom(record.origin, origin);
    // A resident credential answers with the handle it was created against,
    // which is how a person is found without having named an account. It is
    // held to what the registration settled: a handle naming somebody else is
    // an authenticator answering for a credential that is not the one this
    // record describes (contract, `UserId`).
    const handle = credential.user_handle;
    if (handle !== undefined && !equalStrings(handle, record.user)) {
      throw new OpError("auth_invalid", "この assertion は別の利用者の handle を名乗っています");
    }
    // Verified before the challenge is spent, for the reason a registration is
    // (m9): a good-once value burnt by a message that never verified is a value
    // a caller can burn at will.
    const { signCount } = await refusableAsync(() =>
      verifyAssertion(
        credential,
        {
          publicKey: record.public_key,
          ...(record.sign_count === undefined ? {} : { signCount: record.sign_count }),
        },
        { challenge, origin: record.origin, rpIds: [hostOf(record.origin)] },
      ),
    );
    return { record, signCount };
  }

  /** Write down that a credential answered, on the record as it stands now.
   *
   * Read again after the waits: a removal may have taken the credential, and
   * another assertion of the same one may have finished first. The counter is
   * held to the standing record the way it was held to the one read before — a
   * reading that no longer advances it is the reading a copy of the credential
   * would make, whichever of the two arrived first — so the earlier assertion
   * cannot put its lower count back over the later one's (DR-0015 §2.5). */
  async #used(
    record: CredentialRecord,
    signCount: number,
    from: { ip?: string; userAgent?: string },
  ): Promise<Timestamp> {
    const standing = this.deps.records.credential(record.credential_id);
    if (standing === undefined) {
      throw new OpError("auth_invalid", "この credential は登録されていません");
    }
    if (!advances(standing.sign_count, signCount)) {
      throw new OpError("auth_invalid", "the authenticator's counter did not advance");
    }
    const at = this.#now();
    const written = await this.deps.records.write(
      credentialKey(standing.credential_id),
      {
        ...standing,
        sign_count: signCount,
        last_used_at: at,
        ...(from.ip === undefined ? {} : { last_used_ip: from.ip }),
        ...(from.userAgent === undefined ? {} : { last_used_user_agent: from.userAgent }),
      },
      at,
    );
    if (!written) throw new OpError("forbidden", "この credential は削除済みです");
    return at;
  }

  /** Write down which check refused an exchange. The answer says only that it
   * was refused: the operator reading the log is the one who may know which
   * gate it was, and the caller is not. */
  #log(msg: string, fields: Record<string, unknown>): void {
    this.deps.log?.(msg, fields);
  }

  /** Refuse an exchange that came from a page other than the origin it is
   * about.
   *
   * The `Origin` is the browser's own word for where the page was served from,
   * which its script cannot write. A request that states none is a mismatch
   * rather than an exemption: every gate has to be passed, and a caller with
   * nothing to compare has not passed this one (contract, DR-0030 §9).
   *
   * `undefined` is a carrier that observes no header at all — the mesh, where
   * the issuer is asked about a URL rather than posted to — and is not held to
   * one it never had. `null` is an HTTP request that carried none. */
  #cameFrom(origin: Origin, stated: string | null | undefined): void {
    if (stated === undefined) return;
    if (stated !== origin) {
      this.#log("an exchange came from a page other than its own origin", { origin, stated });
      throw refused();
    }
  }

  /** The origins whose pages may read the answers of everything but the two
   * routes that make a person: the origins of every credential this instance
   * holds (contract, DR-0030 §9).
   *
   * Not narrowed by who owns this instance. What this set answers is whether
   * the page is one this instance knows, and whether the person may enter is
   * the ownership record's answer — asking a preflight to carry both would
   * refuse it at exactly the instance where an enrolment is meant to succeed,
   * one holding the credential by replication with no granting yet.
   *
   * Nothing is configured and no list is kept: a registration is what adds an
   * origin, and the removal of the last credential naming it is what takes it
   * away.
   *
   * Compared whole rather than by domain: an RP ID is a domain, so a page at
   * any host under it would be let in — and the refresh route answers a cookie
   * the browser attaches by domain, so a sibling subdomain admitted here would
   * read a person's access token. */
  knownOrigins(): string[] {
    return [...new Set(this.deps.records.credentials().map((record) => record.origin))];
  }

  // --- tokens ---

  /** Make a family for this person, minted by this instance.
   *
   * The origin comes from the credential that answered and is carried on the
   * family: a token says who the person is and nothing about what is holding
   * it, and this is what a connection presenting it is then held to (contract,
   * `TokenFamily.origin`). */
  async mint(user: UserId, origin: Origin, credential?: Base64Url): Promise<MintedSession> {
    const at = this.#now();
    const family: TokenFamily = {
      kind: "token_family",
      user,
      iss: this.deps.self,
      origin,
      access: { value: token(), expires_at: at + ACCESS_TTL_MS },
      refresh: { value: token(), expires_at: at + REFRESH_TTL_MS },
    };
    const key = familyKey(randomBytes(8).toString("hex"));
    // A family the records refused is one a mark stands over. Tokens answered
    // for it would open connections nothing written down admits, so the refusal
    // is the answer.
    if (!(await this.deps.records.write(key, family, at))) {
      throw new OpError("forbidden", `${user} は削除済みです`);
    }
    if (credential !== undefined) this.#openedWith.set(key, credential);
    return { session: { user, access: family.access }, refresh: family.refresh, origin };
  }

  /** Whether some family retired this value, which is what a replay looks
   * like. Read by the carrier choosing between the cookies a browser presented.
   */
  retired(value: Base64Url): boolean {
    return this.deps.records.retiring(digestOf(value)).length > 0;
  }

  /** Rotate a family from a refresh token, wherever it was minted.
   *
   * Written here rather than carried to the instance that minted it: every
   * instance the person owns holds the family and may write it, which is what
   * keeps a refresh working while the minting instance is down. Two of them
   * rotating at once is a collision the losing generation does not survive, and
   * the client it belonged to signs in again (contract, DR-0030 §5). */
  async refreshToken(
    value: Base64Url,
    from: RefreshFrom & { origin?: string | null } = {},
  ): Promise<MintedSession> {
    const held = this.deps.records.byRefresh(value);
    if (held === undefined) {
      // Either a value no family ever issued, or one this family retired. Only
      // the second is a replay, and only it fails anything: the losing side of
      // two parallel rotations holds a value the family also knows nothing of,
      // and failing on that would take down every other page of the same
      // person whenever two instances rotated at once.
      await this.#failReplayed(value);
      throw new OpError("auth_invalid", "この refresh token は使えません");
    }
    // The page asking is held to the family's own origin, as the handshake that
    // presents its access token is.
    this.#cameFrom(held.body.origin, from.origin);
    if (!this.deps.records.owns(held.body.user, this.deps.self)) {
      this.#log("a refresh arrived at an instance its person does not own", {
        user: held.body.user,
      });
      throw refused();
    }
    // Answering the previous generation with the standing pair rather than
    // rotating again: the client that retries is asking for the answer it
    // missed, and rotating on a retry would spend a generation per lost reply.
    if (held.previous) {
      return {
        session: { user: held.body.user, access: held.body.access },
        refresh: held.body.refresh,
        origin: held.body.origin,
      };
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
      ...held.body,
      access,
      refresh: { value: token(), expires_at: at + REFRESH_TTL_MS },
      // The caller's word about why, and where it was asked from, are a hint
      // for the person reading their own sessions back and are never checked
      // (contract, `TokenFamily.last_refresh`).
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
      // holds wherever the reused value is presented.
      retired: retire(held.body, at),
    };
    await this.deps.records.write(held.key, rotated, at);
    return {
      session: { user: rotated.user, access: rotated.access },
      refresh: rotated.refresh,
      origin: rotated.origin,
    };
  }

  /** A value some family retired: the family is failed, because a token in use
   * after it was rotated away is a token that was taken.
   *
   * Matching a retired digest is the only thing that fails a family. A value no
   * family knows anything about was never issued by any of them — which is also
   * what the losing side of two parallel rotations holds — and refusing the
   * call is the whole of the answer (contract, `TokenFamily.retired`). */
  async #failReplayed(value: Base64Url): Promise<void> {
    for (const held of this.deps.records.retiring(digestOf(value))) {
      this.deps.log?.("a refresh token was reused after it was rotated away", {
        user: held.body.user,
      });
      await this.deps.records.fail(held.key);
      this.#openedWith.delete(held.key);
      // The tokens are gone, and so is what they were holding open: a
      // connection that outlived the family it was admitted on would be the
      // stolen token still working.
      this.disconnect(held.body.user);
    }
  }

  /** End a family, which is the whole of what signing out is (contract,
   * `auth.signout`).
   *
   * The cookie names it and nothing else is taken, a caller able to state the
   * value being a caller able to read it. Written wherever the call lands, as a
   * rotation is: the family is replicated and every instance its owner owns may
   * write it. Whether the person still owns this one is not asked — leaving
   * takes no right to enter, and a cookie standing to its expiry because the
   * ownership was taken away would be a door that cannot be closed.
   *
   * A value no family here names is refused and nothing is written, which is
   * the answer a refresh of one gets. A value past its own expiry is not
   * refused: what it names is the family it was minted for.
   *
   * The mark closes the connections the person holds here and reaches the
   * peers' over the records topic, a connection outliving the family it was
   * admitted on being the sign-out not having happened. */
  async signout(
    value: Base64Url,
    from: { origin?: string | null } = {},
  ): Promise<{ user: UserId; origin: Origin }> {
    const held = this.deps.records.naming(value);
    if (held === undefined) throw new OpError("auth_invalid", "この refresh token は使えません");
    // The page asking is held to the family's own origin, as a refresh is.
    this.#cameFrom(held.body.origin, from.origin);
    await this.deps.records.fail(held.key);
    this.#openedWith.delete(held.key);
    this.disconnect(held.body.user);
    return { user: held.body.user, origin: held.body.origin };
  }

  // --- connections ---

  /** Whether an access token opens a connection, until when, from which page,
   * and with which passkey.
   *
   * The origin is stated so the handshake can hold the browser's `Origin` to
   * it: a token says who the person is and nothing about what is holding it,
   * and the family it belongs to is where that is written down. Ownership is
   * read here too — a person who no longer owns this instance holds tokens that
   * open nothing on it. */
  admits(
    access: Base64Url,
  ): { user: UserId; expiresAt: Timestamp; origin: Origin; credential?: Base64Url } | undefined {
    const family = this.deps.records
      .families()
      .find(
        ({ body }) =>
          equalStrings(body.access.value, access) && body.access.expires_at > this.#now(),
      );
    if (family === undefined) return undefined;
    if (!this.deps.records.owns(family.body.user, this.deps.self)) return undefined;
    const credential = this.#openedWith.get(family.key);
    return {
      user: family.body.user,
      expiresAt: family.body.access.expires_at,
      origin: family.body.origin,
      ...(credential === undefined ? {} : { credential }),
    };
  }

  /** Take a connection an access token opened, and close it when the token runs
   * out. The client is expected to have extended it before then; one that did
   * not is the one this is for. */
  hold(
    conn: Requester,
    admitted: { user: UserId; expiresAt: Timestamp; credential?: Base64Url },
  ): void {
    const held: AuthorizedConn = {
      user: admitted.user,
      ...(admitted.credential === undefined ? {} : { credential: admitted.credential }),
      expiresAt: admitted.expiresAt,
    };
    this.#authorized.set(conn, held);
    conn.onClose(() => {
      // The timer goes with the connection: a close scheduled for a socket that
      // is already gone is a handle kept for hours over nothing.
      clearTimeout(held.timer);
      this.#authorized.delete(conn);
    });
    this.#deadline(conn, held);
  }

  /** Who is at the other end of one connection, for the ops that act on the
   * caller's own records and name nobody. */
  held(conn: Requester): AuthorizedConn {
    const standing = this.#authorized.get(conn);
    if (standing === undefined) {
      throw new OpError("auth_invalid", "この接続は token で開かれたものではありません");
    }
    return standing;
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

  /** Extend a live connection with a token got from `/auth/refresh`. */
  extend(conn: Requester, args: AuthExtendArgs): AuthExtendResult {
    const held = this.held(conn);
    const admitted = this.admits(args.access_token);
    if (admitted === undefined) throw new OpError("auth_expired", "この access token は使えません");
    // A token belonging to somebody else does not extend this connection: the
    // connection is one person's, and a second person's token would move its
    // deadline without changing who it speaks as.
    if (admitted.user !== held.user) {
      throw new OpError("auth_invalid", "この access token は別の利用者のものです");
    }
    held.expiresAt = admitted.expiresAt;
    return { auth_expires_at: admitted.expiresAt };
  }

  // --- the rate limit the unauthenticated routes share ---

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
  get heldCounts(): { pending: number; challenges: number; connections: number } {
    this.#forget();
    return {
      pending: this.#pending.size,
      challenges: this.#challenges.size,
      connections: this.#authorized.size,
    };
  }
}

/** The ops an instance answers on a person's connection, and the one it answers
 * for another instance. */
export function authHandlers(auth: Auth) {
  return {
    "auth.extend": (input: HandlerInput): AuthExtendResult =>
      auth.extend(input.conn, input.args as unknown as AuthExtendArgs),
    "auth.account.read": (input: HandlerInput): AuthAccountReadResult =>
      auth.account(auth.held(input.conn).user),
    "auth.ownership.remove": async (input: HandlerInput): Promise<Record<string, never>> => {
      const { instance } = input.args as unknown as AuthOwnershipRemoveArgs;
      const held = auth.held(input.conn);
      // The instance this connection is on is the one it cannot let go of:
      // a person removing their own footing would be cutting the call they are
      // making. Another instance they own, or the command line, does it
      // (contract, `auth.ownership.remove`).
      if (instance === auth.self) {
        throw new OpError("auth_in_use", "今つないでいる instance は、この接続からは手放せません");
      }
      await auth.revoke(held.user, instance);
      return {};
    },
    "auth.credential.remove": async (input: HandlerInput): Promise<Record<string, never>> => {
      const { credential_id: credentialId } = input.args as unknown as AuthCredentialRemoveArgs;
      const held = auth.held(input.conn);
      if (held.credential !== undefined && equalStrings(held.credential, credentialId)) {
        throw new OpError("auth_in_use", "今つないでいる passkey は、この接続からは消せません");
      }
      await auth.removeCredential(held.user, credentialId);
      return {};
    },
    "auth.resolve": (input: HandlerInput): AuthResolveResult => {
      const args = input.args as unknown as AuthResolveArgs;
      if (args.kind === "challenge") {
        auth.spend(args.challenge);
        return { kind: "challenge" };
      }
      // Asked before a person is shown a form, and answered by not refusing:
      // the URL is held here, unspent and inside its window.
      if (args.kind === "alive") {
        auth.checkEnrolment(args.token);
        return { kind: "alive" };
      }
      // The digits arrive unjudged from wherever the browser landed, and are
      // checked here — this is the instance holding both the secret that signed
      // the URL and the count of tries against it.
      return { kind: "claims", claims: auth.resolveEnrolment(args.token, args.code) };
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

/** The instances an enrolment URL hands over.
 *
 * Absent names the issuer's own instance alone, which `instance` already says;
 * naming the field is how a URL hands over more than one (contract,
 * `EnrollClaims.instances`). */
function handedOver(claims: EnrollClaims): InstanceId[] {
  return claims.instances ?? [claims.instance];
}

/** A person's id, which is the WebAuthn user handle itself: sixteen bytes,
 * settled once and never derived from anything (contract, `UserId`). */
function newUserId(): UserId {
  return base64UrlEncode(randomBytes(16));
}

/** The origin an endpoint is published at, where a ceremony could be held
 * there at all.
 *
 * `undefined` for an address a passkey could never be made against — an
 * address literal, a plain-http host that is not the loopback — which is a
 * perfectly good endpoint and no origin this contract will hold a credential
 * to (contract, `Origin`). The operator names one instead. */
function originOf(endpoint: Endpoint): Origin | undefined {
  const origin = new URL(endpoint).origin;
  return validationErrors(OriginSchema, origin).length === 0 ? origin : undefined;
}

/** The relying party a credential at this origin is made under: the origin's
 * host, and nothing wider.
 *
 * WebAuthn would allow a suffix of it, which would let every host under that
 * suffix answer for this one. Holding it to the host is this contract's rule
 * rather than the specification's (contract, `CredentialRecord.origin`). */
export function hostOf(origin: Origin): string {
  return new URL(origin).hostname;
}

/** Sign the claims with the secret made for this one enrolment.
 *
 * A JWS with HS256, because the value travels in a URL fragment and has to
 * survive being carried there: the shape is the conventional one, and the
 * verifier is the issuer itself, so nothing about it is a key anyone else
 * needs (DR-0001 §2.2). */
function sign(claims: EnrollClaims, secret: Buffer): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signing = `${header}.${body}`;
  return `${signing}.${createHmac("sha256", secret).update(signing).digest("base64url")}`;
}

/** What an enrolment token says about itself, before anything has checked it.
 *
 * Read to find the issuer, which is who can check the rest, and to know which
 * origin the ceremony has to be held at. Nothing here is believed: an issuer a
 * caller made up names an instance that holds no such enrolment, which is a
 * refusal. It is read against the contract's own shape rather than field by
 * field — an origin is derived from it to verify a ceremony with, and a value
 * that is not one would be handed to a URL parser as a caller's string. */
export function claimsOf(token: string): EnrollClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OpError("auth_invalid", "この URL の token が壊れています");
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
  } catch {
    throw new OpError("auth_invalid", "この URL の token が読めません");
  }
  if (validationErrors(EnrollClaimsSchema, claims).length > 0) {
    throw new OpError("auth_invalid", "この URL の token の中身が契約の形ではありません");
  }
  return claims as EnrollClaims;
}

/** Read one person's id an operator typed, which is a value the contract spells
 * exactly one way. */
export function userIdOf(stated: string): UserId {
  if (validationErrors(UserIdSchema, stated).length > 0) {
    throw new OpError("invalid_args", `${stated} は利用者の id ではありません`);
  }
  return stated;
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

/** How every one of these binding checks answers.
 *
 * One refusal for all of them, saying that the exchange was not accepted and
 * not which gate it failed: what a caller learns from "the page was wrong"
 * rather than "the instance was" is which value to try next (contract,
 * DR-0030 §9). */
function refused(): OpError {
  return new OpError("auth_invalid", "この要求は受け付けられません");
}
