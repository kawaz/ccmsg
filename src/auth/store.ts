import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthRecord } from "@ccmsg/protocol";

const RECORDS_FILE = "records.json";

/** Where the replicated records are kept.
 *
 * One record at a time, because that is what the set replicates: a peer hands
 * over records, last write wins per key, and a tombstone stands over one key.
 * A store that keeps a row per record therefore writes only the rows that
 * moved, and a token family — the record a person's session rests on, rotated
 * on every refresh — is one such row rather than a share of one document.
 *
 * `load` is synchronous because the set is read as the instance is built,
 * before anything is accepting connections (DR-0015): reading it when the
 * first authentication asked would put the read inside the turn that answers
 * it. A store that can only be read by awaiting belongs behind a build step
 * that awaits, not behind this call. */
export interface AuthRecordStore {
  /** Everything kept. What is not the contract's shape is the caller's to
   * refuse, so a store answers what it holds without reading it. */
  load(): readonly AuthRecord[];
  /** Keep these records, and stop keeping the keys named. */
  commit(kept: readonly AuthRecord[], dropped: readonly string[]): Promise<void>;
  /** Settle once every commit asked for so far has landed. */
  flush(): Promise<void>;
}

/** The store an instance has until it is given another: one JSON document
 * under the state directory.
 *
 * It holds its own copy of what it keeps, which is what lets it answer a
 * per-record commit with a whole-document write. That copy is the file store's
 * working state the way a connection is a database store's, not a second
 * authority: what a record means is settled before it arrives here. */
export function fileRecordStore(dir: string): AuthRecordStore {
  const kept = new Map<string, AuthRecord>();
  const file = join(dir, RECORDS_FILE);
  let writing: Promise<void> = Promise.resolve();

  return {
    load(): readonly AuthRecord[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // Not there is an instance nobody has registered against; damaged by a
        // kill states nothing that can be acted on, and what it held comes back
        // from the peers that hold it too.
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      const records = parsed as AuthRecord[];
      for (const record of records) kept.set(record.key, record);
      return records;
    },

    commit(records: readonly AuthRecord[], dropped: readonly string[]): Promise<void> {
      for (const record of records) kept.set(record.key, record);
      for (const key of dropped) kept.delete(key);
      // The body is taken here, before anything is awaited, so what is written
      // is the set as it was when the change was answered; the writes are
      // chained so that two of them cannot be racing for one file and the
      // older land last (DR-0015).
      const body = JSON.stringify([...kept.values()]);
      const written = writing.then(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.ccmsg-${String(process.pid)}-${String(Date.now())}`;
        // The set holds tokens, so the file is the instance's own to read: it
        // is created with the mode rather than fixed afterwards, so there is no
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
      writing = written.catch(() => {});
      return written;
    },

    async flush(): Promise<void> {
      await writing;
    },
  };
}
