import { createHash } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item } from "./items/index.ts";
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
export const FOLD_CACHE_VERSION = 1;

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
   * describe the file as it stands. */
  async read(path: string): Promise<FoldCacheEntry | undefined> {
    let entry: FoldCacheEntry;
    try {
      entry = JSON.parse(await Bun.file(this.#fileFor(path)).text()) as FoldCacheEntry;
    } catch {
      return undefined;
    }
    if (entry?.version !== FOLD_CACHE_VERSION || entry.path !== path) return undefined;
    if (!Number.isInteger(entry.offset) || entry.offset < 0) return undefined;
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
  save(path: string, offset: number, fold: FoldState, items: readonly Item[]): Promise<void> {
    this.#writing = this.#writing.then(() => this.#write(path, offset, fold, items));
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
    offset: number,
    fold: FoldState,
    items: readonly Item[],
  ): Promise<void> {
    let known: Awaited<ReturnType<typeof stat>>;
    try {
      known = await stat(path);
    } catch {
      return;
    }
    const entry: FoldCacheEntry = {
      version: FOLD_CACHE_VERSION,
      path,
      dev: known.dev,
      ino: known.ino,
      offset,
      fold,
      items: [...items],
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
