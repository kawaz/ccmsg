import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AuthRecord,
  AuthTombstone,
  Base64Url,
  CredentialRecord,
  InstanceId,
  OwnershipRecord,
  Timestamp,
  TokenFamily,
  UserId,
  UserRecord,
} from "@ccmsg/protocol";
import {
  AuthRecord as AuthRecordSchema,
  FAMILY_TOMBSTONE_RETENTION_MS,
  validationErrors,
} from "@ccmsg/protocol";
import { base64UrlDecode, equalBytes, equalStrings } from "./webauthn.ts";

export const AUTH_DIR = "auth";
const RECORDS_FILE = "records.json";

/** Where each of the four records lives in the replicated set (contract,
 * `AuthRecord`).
 *
 * Every key names exactly what a tombstone over it removes, and nothing is
 * nested under anything else: a person is not a prefix their credentials and
 * tokens hang from. That is what lets one credential answer at every instance
 * its owner holds — the credential is keyed by its own id and says which person
 * it is for, rather than sitting under them. */
export function userKey(user: UserId): string {
  return `user/${user}`;
}

export function credentialKey(credentialId: Base64Url): string {
  return `credential/${credentialId}`;
}

/** One granting of one instance to one person.
 *
 * The granting's own id is the last segment, and that is the whole reason it
 * exists: a tombstone refuses every later write to its key without end, so a
 * key made of the instance and the person alone would make the first removal
 * final. With the id, giving an instance up ends one granting and taking it
 * again begins another (contract, `OwnershipRecord.grant`). */
export function ownershipKey(instance: InstanceId, user: UserId, grant: Base64Url): string {
  return `ownership/${instance}/${user}/${grant}`;
}

export function familyKey(id: string): string {
  return `family/${id}`;
}

export interface RecordsDeps {
  /** Where the set is written down (DESIGN §2.5). */
  readonly dir: string;
  /** Hand what this instance wrote to the peers, on the `auth.records` topic. */
  readonly publish: (records: readonly AuthRecord[]) => void;
  readonly now?: () => Timestamp;
}

/** What a merge took in, for the caller that has to act on it: the people whose
 * connections a removal has ended. */
export interface Merged {
  readonly changed: number;
  /** The people an arriving tombstone revoked something of — an ownership, a
   * family, or the person themselves. Whether any given connection has to go is
   * the caller's to decide; what is answered here is who was touched. */
  readonly revoked: UserId[];
}

/** The users, credentials, ownerships, token families and removals every
 * instance holds a copy of (contract, `auth.records`).
 *
 * Last write wins per key, with one exception that is the whole reason a
 * removal is a record rather than an absence: a tombstone refuses every later
 * write to its key, so a peer coming back from a partition cannot carry a
 * revoked credential or granting in as news.
 *
 * Written down for the same reason the store is (DESIGN §2.5): none of it is
 * derived from anything else this instance holds. A credential exists nowhere
 * but here and in the authenticator, and losing a family logs its person out. */
export class AuthRecords {
  readonly #records = new Map<string, AuthRecord>();

  /** The writes already asked for, as one chain. */
  #writing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RecordsDeps) {
    this.#read();
  }

  #now(): Timestamp {
    return (this.deps.now ?? Date.now)();
  }

  /** Take one record from a peer, or from this instance's own file.
   *
   * Answers whether the set moved, which is what decides whether the change is
   * worth writing down and passing on. */
  accept(record: AuthRecord): boolean {
    // Read against the contract before anything is keyed by it. What arrives
    // here is a peer's word or a file from before this contract's generation,
    // and this contract has one generation and no compatibility path: a body
    // shaped otherwise names nothing this instance can act on, and holding it
    // would put a record nobody can read in every later snapshot.
    if (validationErrors(AuthRecordSchema, record).length > 0) return false;
    const held = this.#records.get(record.key);
    if (held !== undefined && held.updated_at >= record.updated_at) return false;
    if (held?.body.kind === "tombstone") return false;
    this.#records.set(record.key, record);
    return true;
  }

  /** Write one record of this instance's own, and tell the mesh.
   *
   * A local write always displaces what the key holds. Last-write-wins settles
   * a disagreement between instances; this is not one — the writer is the
   * authority for what it writes — and two writes landing in the same
   * millisecond, which a rotation and the mint before it easily do, must not
   * silently drop the second. So the instant is moved past what is held rather
   * than compared against it. */
  async write(
    key: string,
    body: AuthRecord["body"],
    now: Timestamp = this.#now(),
  ): Promise<boolean> {
    const held = this.#records.get(key);
    const at = held === undefined ? now : Math.max(now, held.updated_at + 1);
    const record: AuthRecord = { key, updated_at: at, body };
    // This instance's own write, so a body outside the contract is a fault here
    // rather than a peer's word to be dropped quietly: it would be handed to
    // every peer and refused by each of them, and the one place that could say
    // why is this one.
    const problems = validationErrors(AuthRecordSchema, record);
    if (problems.length > 0) {
      throw new Error(`auth record ${key} is not the contract's shape: ${problems.join("; ")}`);
    }
    if (!this.accept(record)) return false;
    // Handed to the peers once it is written down, so no peer holds a record
    // this instance would not have after a restart.
    await this.#persist();
    this.deps.publish([record]);
    return true;
  }

  /** Take a batch a peer sent.
   *
   * Answers the people a removal arrived for, because a tombstone means more
   * than a record going away: whoever it names may have connections open here,
   * and a connection left standing on a revoked granting is the removal not
   * having happened. */
  async merge(records: readonly AuthRecord[]): Promise<Merged> {
    let changed = 0;
    const revoked: UserId[] = [];
    for (const record of records) {
      const wasHeld = this.#records.get(record.key);
      if (!this.accept(record)) continue;
      changed += 1;
      if (record.body.kind !== "tombstone") continue;
      // What the mark removed is read from what stood under it a moment ago:
      // the key alone says which record went, and the person it belonged to is
      // in the body that is now gone.
      const user = userOf(wasHeld);
      if (user !== undefined) revoked.push(user);
    }
    if (changed > 0) await this.#persist();
    return { changed, revoked };
  }

  /** Put a mark over one key. What it removes is what the key names, and
   * nothing under it: a granting rather than a person, one passkey rather than
   * every passkey (contract, `AuthTombstone`). */
  async erase(key: string, keep?: number): Promise<AuthRecord | undefined> {
    if (this.#records.get(key) === undefined) return undefined;
    const at = this.#now();
    const body: AuthTombstone = {
      kind: "tombstone",
      deleted_at: at,
      ...(keep === undefined ? {} : { expires_at: at + keep }),
    };
    const held = this.#records.get(key);
    const stamped = held === undefined ? at : Math.max(at, held.updated_at + 1);
    const record: AuthRecord = { key, updated_at: stamped, body };
    this.#records.set(key, record);
    await this.#persist();
    this.deps.publish([record]);
    return record;
  }

  /** Whether a mark stands over this key, which is what a write to it has to be
   * refused by. */
  removed(key: string): boolean {
    return this.#records.get(key)?.body.kind === "tombstone";
  }

  user(user: UserId): UserRecord | undefined {
    const held = this.#records.get(userKey(user));
    return held?.body.kind === "user" ? held.body : undefined;
  }

  users(): UserRecord[] {
    const found: UserRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.body.kind === "user") found.push(record.body);
    }
    return found;
  }

  credentials(): CredentialRecord[] {
    const found: CredentialRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.body.kind === "credential") found.push(record.body);
    }
    return found;
  }

  /** The credential an assertion names. Looked up by the id the authenticator
   * signed, which is what lets a person authenticate without naming anybody.
   *
   * Compared as bytes rather than as text: base64url is not a canonical
   * spelling — padding may or may not be there, and a decoder accepts more than
   * one string for the same value — so two spellings of one credential id would
   * otherwise be two credentials, and a person would be turned away from their
   * own. */
  credential(credentialId: Base64Url): CredentialRecord | undefined {
    const wanted = base64UrlDecode(credentialId);
    return this.credentials().find((record) =>
      equalBytes(base64UrlDecode(record.credential_id), wanted),
    );
  }

  ownerships(): OwnershipRecord[] {
    const found: OwnershipRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.body.kind === "ownership") found.push(record.body);
    }
    return found;
  }

  /** Whether this person owns this instance, which is the whole of what admits
   * them to it.
   *
   * Any granting still alive answers it. A pair may hold more than one — the
   * person was added from two places, or given the instance back after letting
   * it go — and the question is whether they hold it at all rather than how
   * often (contract, `OwnershipRecord.grant`). */
  owns(user: UserId, instance: InstanceId): boolean {
    return this.ownerships().some((record) => record.user === user && record.instance === instance);
  }

  /** Every granting of one instance to one person, which is what letting it go
   * has to put a mark over — all of them, there being no shape for ending one
   * of two grantings of the same thing. */
  grantsOf(user: UserId, instance: InstanceId): { key: string; body: OwnershipRecord }[] {
    const found: { key: string; body: OwnershipRecord }[] = [];
    for (const record of this.#records.values()) {
      if (record.body.kind !== "ownership") continue;
      if (record.body.user !== user || record.body.instance !== instance) continue;
      found.push({ key: record.key, body: record.body });
    }
    return found;
  }

  families(): { key: string; body: TokenFamily }[] {
    const found: { key: string; body: TokenFamily }[] = [];
    for (const record of this.#records.values()) {
      if (record.body.kind === "token_family") found.push({ key: record.key, body: record.body });
    }
    return found;
  }

  /** The family an access token belongs to, if it is still the standing one and
   * has not run out. */
  byAccess(value: Base64Url, now: Timestamp = this.#now()): TokenFamily | undefined {
    return this.families().find(
      ({ body }) => equalStrings(body.access.value, value) && body.access.expires_at > now,
    )?.body;
  }

  /** The family a refresh token belongs to, and which generation it was.
   *
   * The generation before the standing one is answered as `previous` rather
   * than refused: a client whose rotation was lost on the way retries with the
   * value it still holds, and that is not a replay (contract, `TokenFamily`).
   * Anything older matches nothing here. */
  byRefresh(
    value: Base64Url,
    now: Timestamp = this.#now(),
  ): { key: string; body: TokenFamily; previous: boolean } | undefined {
    for (const held of this.families()) {
      if (equalStrings(held.body.refresh.value, value) && held.body.refresh.expires_at > now) {
        return { ...held, previous: false };
      }
      const before = held.body.previous_refresh;
      if (before !== undefined && equalStrings(before.value, value) && before.expires_at > now) {
        return { ...held, previous: true };
      }
    }
    return undefined;
  }

  /** Fail one family, which is what a replayed token does to the whole of it.
   *
   * A tombstone rather than an expired record. A peer that was partitioned when
   * this happened still holds the live copy, and an ordinary record would let
   * that copy come back as the newer write when the partition heals. A mark
   * refuses every later write to the key, which is exactly what a revoked
   * family needs. It is kept for the same seven days a removal's is: past the
   * longest refresh token, there is nothing left for a returning peer to
   * revive. */
  async fail(key: string): Promise<void> {
    const held = this.#records.get(key);
    if (held === undefined || held.body.kind !== "token_family") return;
    await this.erase(key, FAMILY_TOMBSTONE_RETENTION_MS);
  }

  /** The family a value was retired by, recognised the one way a replay is: the
   * digest a family wrote down when it rotated that value away.
   *
   * A value no family knows anything about is answered by nothing here. It was
   * never issued by any of them — which is also what the losing side of two
   * parallel rotations holds — and refusing the call is the whole of the
   * answer (contract, `TokenFamily.retired`). */
  retiring(digest: string, now: Timestamp = this.#now()): { key: string; body: TokenFamily }[] {
    return this.families().filter(({ body }) =>
      (body.retired ?? []).some((one) => one.expires_at > now && equalStrings(one.hash, digest)),
    );
  }

  /** Every record, for the snapshot a peer's subscription is answered with. */
  all(): AuthRecord[] {
    this.#expire();
    return [...this.#records.values()];
  }

  /** Drop what has run out: a family past its refresh token, and a mark past
   * its retention. A credential's and an ownership's marks are kept without
   * end.
   *
   * Read rather than swept, like the store's own removals: nothing here runs on
   * a timer (M3), and a record that outlives its window until the next read is
   * one no read can see anyway. */
  #expire(): void {
    const now = this.#now();
    for (const [key, record] of this.#records) {
      const body = record.body;
      if (body.kind === "token_family" && body.refresh.expires_at <= now) {
        this.#records.delete(key);
      }
      if (body.kind === "tombstone" && body.expires_at !== undefined && body.expires_at <= now) {
        this.#records.delete(key);
      }
    }
  }

  /** Settle once every write asked for so far has landed. What a stop waits on
   * before it lets go of the config home (DESIGN §8.5 step 4). */
  async flush(): Promise<void> {
    await this.#writing;
  }

  /** The file, read as this is built — before the instance is accepting
   * anything, so nobody is waiting on it (DR-0015). Reading it when the first
   * authentication asked would put the read inside the turn that answers it,
   * and the `auth.records` snapshot is answered from what is held rather than
   * from a promise. A file that is not there is an instance nobody has
   * registered against, which is what an empty set says. */
  #read(): void {
    let text: string;
    try {
      text = readFileSync(this.#file(), "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A file a kill damaged states nothing this instance can act on, and the
      // records it held will come back from the peers that also hold them.
      return;
    }
    if (!Array.isArray(parsed)) return;
    // Each one through the same gate a peer's record goes through, so a file
    // written before this contract's generation leaves nothing behind.
    for (const record of parsed as AuthRecord[]) this.accept(record);
    this.#expire();
  }

  /** The set as it stands, written whole.
   *
   * The body is taken here, before anything is awaited, so what is written is
   * the set as it was when the change was answered; the writes are chained so
   * that two of them cannot be racing for one file and the older land last
   * (DR-0015). */
  #persist(): Promise<void> {
    this.#expire();
    const body = JSON.stringify([...this.#records.values()]);
    const written = this.#writing.then(async () => {
      await mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
      const file = this.#file();
      const temporary = `${file}.ccmsg-${String(process.pid)}-${String(Date.now())}`;
      // The set holds tokens, so the file is the instance's own to read: it is
      // created with the mode rather than fixed afterwards, so there is no
      // instant at which it stands readable by anyone else.
      await writeFile(temporary, body, { mode: 0o600 });
      try {
        await rename(temporary, file);
      } catch (cause) {
        await unlink(temporary);
        throw cause;
      }
    });
    // The chain carries the order, not the outcome: a write that failed is
    // answered to its own caller, and the ones behind it still go.
    this.#writing = written.catch(() => {});
    return written;
  }

  #file(): string {
    return join(this.deps.dir, RECORDS_FILE);
  }
}

/** Who a record belonged to, for a mark that has just replaced it. */
function userOf(record: AuthRecord | undefined): UserId | undefined {
  const body = record?.body;
  if (body === undefined || body.kind === "tombstone") return undefined;
  return body.user;
}

/** Where the records live under a state directory. */
export function recordsDir(stateDir: string): string {
  return join(stateDir, AUTH_DIR);
}
