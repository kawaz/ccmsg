import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClassificationState, Item } from "./items/index.ts";
import type { FoldState } from "./fold.ts";

/** Which shape of folded state this build can read back.
 *
 * A cache entry is the answer a past run derived, taken on trust: nothing
 * re-reads the bytes it was derived from. So it may only be read back by a
 * build that would have derived the same answer from them, and the version is
 * how that is asserted — raise it whenever what the fold keeps or how it reads
 * a record changes, and every entry written before says nothing to this build.
 *
 * `test/transcript.test.ts` holds the digest of the sources this number stands
 * for and fails when they move without it, so the assertion is checked rather
 * than remembered. */
export const FOLD_CACHE_VERSION = 4;

/** What one session's fold had reached, as it is written down.
 *
 * The offset is what makes the rest of it usable: it says which bytes the
 * state accounts for, so the next run reads from there instead of from the
 * beginning. The file's identity is beside it because the offset counts bytes
 * of one file — a transcript replaced by another of the same name has bytes
 * this state describes none of. */
export interface FoldCacheEntry {
  readonly version: number;
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  /** Just past the last record the state accounts for. */
  readonly offset: number;
  readonly fold: FoldState;
  /** What the reading that produced the items would carry into the next record:
   * the turn it had reached, whose file it decided this is, and the calls still
   * waiting for an answer. Without it a resumed run would answer a record
   * differently from the run that read everything before it — counting turns
   * from zero again, and calling a result whose call is known here the reserved
   * name for a call nobody saw. */
  readonly reading: ClassificationState;
  /** The end of the reading, which is what a subscription opens on. Kept with
   * the fold because both are derived from the same pass, and a resumed run
   * that held only the fold would open the items topic on an empty list while
   * claiming to know the session. */
  readonly items: readonly Item[];
}

/** Where folded transcripts are kept between runs.
 *
 * Everything here can be derived again from the transcript it came from, so a
 * miss, a discarded entry and an emptied directory are all the same thing: the
 * file is read from its beginning. Nothing asks whether a write succeeded for
 * that reason — a cache that could not be written costs the next run one read.
 *
 * Writes are chained rather than overlapped, so two saves of the same session
 * cannot race over the temporary file they rename from. */
export class FoldCache {
  #writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  /** What was folded out of this file, or nothing when what is on disk does not
   * describe the file as it stands.
   *
   * It waits behind the writes already asked for rather than reading straight
   * away. A caller that gives an entry up and then reads again — a reading that
   * begins from the top after two processes moved the file under it — asks for
   * the drop and the read in one breath, and a read that did not queue behind
   * the drop would hand back the entry that was just given up. Chaining it is
   * what makes "the entry is gone" true by the time anything looks. */
  async read(path: string): Promise<FoldCacheEntry | undefined> {
    await this.#writing;
    let entry: FoldCacheEntry;
    try {
      entry = JSON.parse(await Bun.file(this.#fileFor(path)).text()) as FoldCacheEntry;
    } catch {
      return undefined;
    }
    // The shape is checked and not assumed. An entry whose version matches but
    // whose fields are not what this build reads back would otherwise be taken
    // apart by whoever reads it, and a reading that throws leaves the session
    // unopenable until the instance restarts — where a file that says nothing
    // this build can use costs one reading (DR-0015 §2.5: what an await brings
    // back is an input, not a promise kept).
    if (!describes(entry, path)) return undefined;
    let known: Awaited<ReturnType<typeof stat>>;
    try {
      known = await stat(path);
    } catch {
      return undefined;
    }
    // A different file under the same name, or the same file grown shorter than
    // the bytes the state accounts for: either way the state describes bytes
    // that are not there, and the file is read from its beginning.
    if (known.dev !== entry.dev || known.ino !== entry.ino) return undefined;
    if (known.size < entry.offset) return undefined;
    return entry;
  }

  /** Keep what has been folded so far. The file's identity is read here rather
   * than taken from the caller, so what is written describes the file the
   * offset was actually counted in. */
  save(
    path: string,
    offset: number,
    fold: FoldState,
    reading: ClassificationState,
    items: readonly Item[],
  ): Promise<void> {
    // Everything is taken now rather than when the write runs: the offset
    // describes this moment, and the state is copied to its leaves because a
    // fold still reading and a reading still filling in its calls write into
    // the very objects handed over here — a copy one level deep would put
    // records past the offset into an entry that claims to end at it. The
    // file's identity is asked for now for the same reason: the offset counts
    // bytes of the file that is there as this is called, and a write that
    // stats later would name whatever file had taken the name by then.
    let kept: Pick<FoldCacheEntry, "fold" | "reading" | "items">;
    try {
      kept = structuredClone({ fold, reading, items });
    } catch {
      // State that cannot be copied cannot be written either, and a cache that
      // was not written costs the next run one read.
      return this.#writing;
    }
    const identity = stat(path).catch(() => undefined);
    this.#writing = this.#writing.then(() => this.#write(path, identity, offset, kept));
    return this.#writing;
  }

  /** Forget what was folded out of this file, for a transcript that turned out
   * to be another one. */
  drop(path: string): Promise<void> {
    this.#writing = this.#writing.then(async () => {
      await unlink(this.#fileFor(path)).catch(() => undefined);
    });
    return this.#writing;
  }

  async #write(
    path: string,
    identity: Promise<Stats | undefined>,
    offset: number,
    kept: Pick<FoldCacheEntry, "fold" | "reading" | "items">,
  ): Promise<void> {
    const known = await identity;
    if (known === undefined) return;
    const entry: FoldCacheEntry = {
      version: FOLD_CACHE_VERSION,
      path,
      dev: known.dev,
      ino: known.ino,
      offset,
      ...kept,
    };
    const file = this.#fileFor(path);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(temporary, JSON.stringify(entry));
      await rename(temporary, file);
    } catch {
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** One file per transcript, named by a digest of its path: the path is what
   * identifies the transcript, and a digest of it is a name every filesystem
   * takes however the path was spelled. */
  #fileFor(path: string): string {
    return join(this.dir, `${createHash("sha256").update(path).digest("hex").slice(0, 32)}.json`);
  }
}

/** Whether what was read back is an entry this build can take up.
 *
 * Checked as deep as anything walks it, not as deep as it is restored: restoring
 * copies the lists, but the records read after it take a call's name and
 * arguments apart, write into a teammate's status, add to a todo's dependency
 * lists, and match the outstanding calls back to the items by id. A field of
 * the wrong shape at any of those depths is a file that says nothing this build
 * can use, which is the same as no file at all. What lies below those depths —
 * the values of a call's arguments, a todo's subject, the rest of an item — is
 * carried whole and stated as it was written, so it is not checked. */
function describes(entry: unknown, path: string): entry is FoldCacheEntry {
  if (!isObject(entry)) return false;
  if (entry["version"] !== FOLD_CACHE_VERSION || entry["path"] !== path) return false;
  if (!counted(entry["offset"]) || !counted(entry["dev"]) || !counted(entry["ino"])) return false;
  const items = entry["items"];
  if (!Array.isArray(items) || !items.every(isObject)) return false;
  return states(entry["fold"]) && reads(entry["reading"]);
}

/** Every list of the fold is pairs of a key and an object, and the three whose
 * objects a later record reaches into hold what that reaching expects. */
function states(fold: unknown): boolean {
  if (!isObject(fold)) return false;
  const deeper: Record<string, (value: Record<string, unknown>) => boolean> = {
    calls: (call) => typeof call["name"] === "string" && isObject(call["input"]),
    teammates: (each) => isObject(each["status"]) && typeof each["status"]["name"] === "string",
    todos: (todo) => strings(todo["blocked_by"]) && strings(todo["blocks"]),
  };
  for (const key of ["files", "todos", "teammates", "background", "workflows", "agents", "calls"]) {
    const held = fold[key];
    if (!Array.isArray(held)) return false;
    for (const pair of held) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") return false;
      const value: unknown = pair[1];
      if (!isObject(value) || deeper[key]?.(value) === false) return false;
    }
  }
  return true;
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((each) => typeof each === "string");
}

function reads(reading: unknown): boolean {
  if (!isObject(reading)) return false;
  if (!counted(reading["turn"]) || typeof reading["subject"] !== "string") return false;
  if (!Array.isArray(reading["calls"])) return false;
  for (const pair of reading["calls"]) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") return false;
    const call: unknown = pair[1];
    if (!isObject(call) || typeof call["tool"] !== "string" || typeof call["name"] !== "string") {
      return false;
    }
    if (call["message"] !== undefined && typeof call["message"] !== "string") return false;
  }
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function counted(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
