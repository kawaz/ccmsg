import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AuthRecord,
  AuthTombstone,
  Base64Url,
  CredentialRecord,
  InstanceId,
  Subject,
  Timestamp,
  TokenFamily,
} from "@ccmsg/protocol";
import { FAMILY_TOMBSTONE_RETENTION_MS } from "@ccmsg/protocol";
import { equalStrings } from "./webauthn.ts";

export const AUTH_DIR = "auth";
const RECORDS_FILE = "records.json";

/** Where a credential and a family live in the replicated set.
 *
 * Both are under the subject they belong to, which is what makes a removal
 * expressible: a person is removed as a person, and the mark that says so has
 * to refuse every key their credentials and tokens could be written under —
 * including ones this instance has never seen, held by a peer that is
 * partitioned right now (DR-0001 §2.6). A tombstone therefore stands for a
 * prefix rather than for one key. */
export function credentialKey(sub: Subject, credentialId: Base64Url): string {
  return `credential/${sub}/${credentialId}`;
}

export function familyKey(sub: Subject, id: string): string {
  return `family/${sub}/${id}`;
}

export function credentialPrefix(sub: Subject): string {
  return `credential/${sub}`;
}

export function familyPrefix(sub: Subject): string {
  return `family/${sub}`;
}

/** Whether a tombstone's key covers another key: the key itself, or anything
 * written beneath it. */
function covers(tombstone: string, key: string): boolean {
  return key === tombstone || key.startsWith(`${tombstone}/`);
}

export interface RecordsDeps {
  /** Where the set is written down (§3.6). */
  readonly dir: string;
  /** Hand what this instance wrote to the peers, on the `auth_records` topic. */
  readonly publish: (records: readonly AuthRecord[]) => void;
  readonly now?: () => Timestamp;
}

/** The credentials, token families and removals every instance holds a copy of
 * (DR-0001 §2.6).
 *
 * Last write wins per key, with one exception that is the whole reason a
 * removal is a record rather than an absence: a tombstone refuses every later
 * write to the keys it covers, so a peer coming back from a partition cannot
 * carry a revoked credential in as news.
 *
 * Written down for the same reason the store is (§3.6): none of it is derived
 * from anything else this instance holds. A credential exists nowhere but here
 * and in the authenticator, and losing a family logs its person out. */
export class AuthRecords {
  readonly #records = new Map<string, AuthRecord>();
  #loaded = false;

  constructor(private readonly deps: RecordsDeps) {}

  #now(): Timestamp {
    return (this.deps.now ?? Date.now)();
  }

  /** Take one record from a peer, or from this instance's own file.
   *
   * Answers whether the set moved, which is what decides whether the change is
   * worth writing down and passing on. */
  accept(record: AuthRecord): boolean {
    this.#load();
    const held = this.#records.get(record.key);
    if (held !== undefined && held.updated_at >= record.updated_at) return false;
    if (this.#refused(record)) return false;
    this.#records.set(record.key, record);
    if (record.body.kind === "tombstone") this.#sweepUnder(record.key);
    return true;
  }

  /** Whether a tombstone standing over this key refuses it.
   *
   * A tombstone is itself refused by another tombstone covering it, so two
   * removals of the same subject do not fight; the newer one simply does not
   * displace the older, which `accept` has already settled by instant. */
  #refused(record: AuthRecord): boolean {
    for (const held of this.#records.values()) {
      if (held.body.kind !== "tombstone") continue;
      if (held.key === record.key) continue;
      if (covers(held.key, record.key)) return true;
    }
    return false;
  }

  /** Drop what a fresh tombstone covers. The mark alone would be enough to
   * refuse later writes, but leaving the records themselves in place would
   * leave a removed person's key usable by this instance. */
  #sweepUnder(tombstone: string): void {
    for (const [key, held] of this.#records) {
      if (held.body.kind === "tombstone") continue;
      if (covers(tombstone, key)) this.#records.delete(key);
    }
  }

  /** Write one record of this instance's own, and tell the cluster. */
  write(key: string, body: AuthRecord["body"], at: Timestamp = this.#now()): boolean {
    const record: AuthRecord = { key, updated_at: at, body };
    if (!this.accept(record)) return false;
    this.#persist();
    this.deps.publish([record]);
    return true;
  }

  /** Take a batch a peer sent, and say what actually changed — nothing is
   * relayed onward, so the answer is for the log and for the file. */
  merge(records: readonly AuthRecord[]): number {
    let changed = 0;
    for (const record of records) {
      if (this.accept(record)) changed += 1;
    }
    if (changed > 0) this.#persist();
    return changed;
  }

  /** Remove one person: their credentials and every token they hold.
   *
   * Two marks rather than one because the two halves are kept for different
   * lengths of time. A family expires with its refresh token, so the mark over
   * it only has to outlive the longest one; a credential has no expiry of its
   * own, so the mark over it has none either (DR-0001 §2.6). */
  remove(sub: Subject): AuthRecord[] {
    const at = this.#now();
    const credential: AuthTombstone = { kind: "tombstone", sub, deleted_at: at };
    const family: AuthTombstone = {
      kind: "tombstone",
      sub,
      deleted_at: at,
      expires_at: at + FAMILY_TOMBSTONE_RETENTION_MS,
    };
    const marks: AuthRecord[] = [
      { key: credentialPrefix(sub), updated_at: at, body: credential },
      { key: familyPrefix(sub), updated_at: at, body: family },
    ];
    for (const mark of marks) this.accept(mark);
    this.#persist();
    this.deps.publish(marks);
    return marks;
  }

  /** Whether this subject has been removed, which is what a registration for
   * one has to be refused by. */
  removed(sub: Subject): boolean {
    this.#load();
    const held = this.#records.get(credentialPrefix(sub));
    return held?.body.kind === "tombstone";
  }

  credentials(): CredentialRecord[] {
    this.#load();
    const found: CredentialRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.body.kind === "credential") found.push(record.body);
    }
    return found;
  }

  /** The credential an assertion names. Looked up by the id the authenticator
   * signed, which is what lets a person authenticate without naming a subject
   * (DR-0001 §2.5). */
  credential(credentialId: Base64Url): CredentialRecord | undefined {
    return this.credentials().find((record) => equalStrings(record.credential_id, credentialId));
  }

  families(): { key: string; body: TokenFamily }[] {
    this.#load();
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
   * Anything older matches nothing here, and the caller fails the family. */
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

  /** Drop one family, which is what a reused token does to the whole of it.
   *
   * A plain deletion rather than a tombstone: the family's `iss` is its only
   * writer, so there is no peer that could write it back, and the deletion
   * travels as an expired family rather than as a mark of its own. */
  fail(key: string): void {
    this.#load();
    const held = this.#records.get(key);
    if (held === undefined || held.body.kind !== "token_family") return;
    const at = this.#now();
    // Expired in place rather than removed, because an absence says nothing to
    // a peer: the record has to travel, and one that has run out is refused
    // everywhere it lands.
    const failed: TokenFamily = {
      ...held.body,
      access: { value: held.body.access.value, expires_at: at },
      refresh: { value: held.body.refresh.value, expires_at: at },
    };
    this.write(key, failed, at);
  }

  /** Every record, for the snapshot a peer's subscription is answered with. */
  all(): AuthRecord[] {
    this.#load();
    this.#expire();
    return [...this.#records.values()];
  }

  /** Drop what has run out: a family past its refresh token, and a family's
   * tombstone past its retention. A credential's tombstone is kept without end.
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

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
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
    for (const record of parsed as AuthRecord[]) {
      if (typeof record?.key === "string" && typeof record.updated_at === "number") {
        this.#records.set(record.key, record);
      }
    }
    this.#expire();
  }

  #persist(): void {
    this.#expire();
    mkdirSync(this.deps.dir, { recursive: true });
    const file = this.#file();
    const temporary = `${file}.ccmsg-${String(process.pid)}-${String(Date.now())}`;
    // The set holds tokens, so the file is the instance's own to read: it is
    // created with the mode rather than fixed afterwards, so there is no
    // instant at which it stands readable by anyone else.
    writeFileSync(temporary, JSON.stringify([...this.#records.values()]), { mode: 0o600 });
    try {
      renameSync(temporary, file);
    } catch (cause) {
      unlinkSync(temporary);
      throw cause;
    }
  }

  #file(): string {
    return join(this.deps.dir, RECORDS_FILE);
  }
}

/** Where the records live under a state directory. */
export function recordsDir(stateDir: string): string {
  return join(stateDir, AUTH_DIR);
}

/** The parent of a path, made when a caller wants to write into it. */
export function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
}

/** Whether an instance is the one allowed to write this family (DR-0001 §2.4). */
export function writes(family: TokenFamily, self: InstanceId): boolean {
  return family.iss === self;
}
