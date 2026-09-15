import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import type {
  DirEntry,
  DirListArgs,
  DirListResult,
  FileCreateArgs,
  FileCreateResult,
  FileDeleteArgs,
  FileDeleteResult,
  FileEditArgs,
  FileEditResult,
  FileFindArgs,
  FileFindHit,
  FileFindResult,
  FileReadArgs,
  FileReadResult,
  FileStatArgs,
  FileStatResult,
  FileStatEntry,
  FileWriteArgs,
  FileWriteResult,
  Sid,
  Timestamp,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../dispatch/index.ts";
import type { Containment, Located, Viewer } from "./containment.ts";

/** How much of a file `file.read` carries. Larger files are answered with their
 * head and `truncated`, so one file can never cost the connection more than
 * this however big it grew (DR-0008 §5). */
const READ_LIMIT = 512 * 1024;

/** How much of a file decides whether it is text. A NUL in the head is what
 * separates a document from a binary here: enough to keep an image out of a
 * text pane, and deliberately not a full content-type guess. */
const SNIFF = 8 * 1024;

/** What one walk may answer with, and how far it may look to find it. The
 * second is what bounds a walk over a tree whose matches are few — without it a
 * query that matches nothing is a walk of everything. */
const FIND_HITS = 200;
const FIND_VISITS = 20_000;

/** The eight ops that read and write files.
 *
 * None of them decides what may be reached: each turns its arguments into a
 * located path, does the one thing it names, and states the result in the shape
 * the kind implies. The decision is `Containment`'s, and what it needs of the
 * caller — the role dispatch states for a `scope: "role"` op, and the session
 * the connection speaks for — is handed over unread. */
export function fileHandlers(paths: Containment, duplicated: (sid: Sid) => boolean) {
  const viewer = (input: HandlerInput): Viewer => ({
    role: input.role,
    sid: input.identity?.sid,
  });
  const writes = new Writes();

  const handlers = {
    "dir.list": async (input: HandlerInput): Promise<DirListResult> => {
      const args = input.args as unknown as DirListArgs;
      const at = await paths.root(args, viewer(input));
      const stat = await existing(at);
      if (!stat.isDirectory()) throw new OpError("not_found", `${args.path ?? ""} is not a folder`);
      return {
        sid: args.sid,
        path: at.path,
        entries: await entriesOf(at.real),
      };
    },

    "file.read": async (input: HandlerInput): Promise<FileReadResult> => {
      const args = input.args as unknown as FileReadArgs;
      const at = await paths.locate(args, viewer(input));
      const stat = await existing(at);
      if (!stat.isFile()) throw new OpError("not_found", `${args.path} is not a file`);
      // As much as the answer may carry and no more: a file larger than the
      // limit is answered from its head, so reading it whole would cost the
      // instance the whole of a file whose size is what the limit exists to
      // refuse.
      const head = await bytesOf(at.real, READ_LIMIT);
      const binary = isBinary(head);
      return {
        sid: args.sid,
        path: at.path,
        size: stat.size,
        truncated: stat.size > head.byteLength,
        binary,
        content: binary ? "" : head.toString("utf8"),
        mtime_at: mtimeOf(stat),
      };
    },

    "file.write": async (input: HandlerInput): Promise<FileWriteResult> => {
      const args = input.args as unknown as FileWriteArgs;
      const at = await paths.inbox(args.sid, args.path, viewer(input));
      // The inbox takes new notes, so an existing name is refused rather than
      // replaced; the folder itself is made, since a repository that has never
      // had one is exactly where the first note goes (DR-0019 §2.1).
      await mkdir(dirname(at.real), { recursive: true });
      await writes.to(at.real, () => create(at.real, args.content));
      return { sid: args.sid, path: at.path };
    },

    "file.create": async (input: HandlerInput): Promise<FileCreateResult> => {
      const args = input.args as unknown as FileCreateArgs;
      const at = await paths.locate(args, viewer(input));
      const parent = dirname(at.real);
      if (!(await isDirectory(parent))) {
        throw new OpError("not_found", `${args.path} has no folder to be created in`);
      }
      await writes.to(at.real, () => create(at.real, args.content));
      return { sid: args.sid, path: at.path };
    },

    "file.edit": async (input: HandlerInput): Promise<FileEditResult> => {
      const args = input.args as unknown as FileEditArgs;
      const at = await paths.locate(args, viewer(input));
      // The token is held against the file inside the write chain, so what it
      // is compared with is the file no other write of this instance can be
      // changing meanwhile: two edits carrying the same token are answered one
      // after the other, and the second sees the first's file and is refused.
      const after = await writes.to(at.real, async () => {
        const before = await existing(at);
        if (!before.isFile()) throw new OpError("not_found", `${args.path} is not a file`);
        if (isBinary(await bytesOf(at.real, SNIFF))) {
          throw new OpError("not_a_text_file", `${args.path} holds binary content`);
        }
        if (mtimeOf(before) !== args.expected_mtime_at || before.size !== args.expected_size) {
          throw new OpError("file_conflict", `${args.path} changed since it was read`);
        }
        await replace(at.real, args.content);
        return stat(at.real);
      });
      return {
        sid: args.sid,
        path: at.path,
        size: after.size,
        mtime_at: mtimeOf(after),
      };
    },

    "file.delete": async (input: HandlerInput): Promise<FileDeleteResult> => {
      const args = input.args as unknown as FileDeleteArgs;
      const at = await paths.locate(args, viewer(input));
      // What is unlinked is what is named, so this reads the name itself rather
      // than what it resolves to: a symlink is refused as the wrong kind of
      // thing instead of taking its target's answer. The resolved path is the
      // one containment admitted and would answer for the target, which is the
      // file a link inside the root could otherwise be pointed at.
      const stat = await lstatOf(at.named);
      if (stat === undefined) throw new OpError("not_found", `${args.path} is not there`);
      if (!stat.isFile()) {
        throw new OpError("path_forbidden", `${args.path} is not a plain file`);
      }
      await unlink(at.named);
      return { sid: args.sid, path: at.path };
    },

    "file.find": async (input: HandlerInput): Promise<FileFindResult> => {
      const args = input.args as unknown as FileFindArgs;
      const at = await paths.root(
        {
          sid: args.sid,
          kind: args.kind,
          ...(args.root === undefined ? {} : { path: args.root }),
        },
        viewer(input),
      );
      const terms = parseQuery(args.query);
      // A query with nothing to include matches nothing rather than the whole
      // tree, so a cleared search box costs no walk at all.
      if (terms.include.length === 0) return { sid: args.sid, hits: [], truncated: false };
      const walk = await find(at, terms, args.respect_gitignore ?? true);
      return { sid: args.sid, hits: walk.hits, truncated: walk.truncated };
    },

    "file.stat": async (input: HandlerInput): Promise<FileStatResult> => {
      const args = input.args as unknown as FileStatArgs;
      const results = await Promise.all(
        args.paths.map(async (path): Promise<FileStatEntry | null> => {
          const at = await paths.identify(args.sid, path, viewer(input));
          if (at === undefined || !(await isFile(at.real))) return null;
          return { kind: at.kind, path: at.path };
        }),
      );
      return { results };
    },
  };

  // Every one of them names the session whose files are being reached, and
  // every one of them is refused while two processes are running it: the tree
  // a caller means is the one that session sees, and which of two runs that is
  // is not settled (DR-0001 §3). Applied once here rather than at the head of
  // eight bodies, so an op added later cannot be the one that forgot.
  return Object.fromEntries(
    Object.entries(handlers).map(([op, handler]) => [
      op,
      (input: HandlerInput) => {
        const sid = (input.args as unknown as { sid: Sid }).sid;
        if (duplicated(sid)) {
          throw new OpError(
            "session_duplicated",
            `${sid} is being run by more than one process, so which of them this names is not settled`,
          );
        }
        return handler(input);
      },
    ]),
  ) as typeof handlers;
}

/** The file a located path names, or the contract's word for "not there". */
async function existing(at: Located) {
  try {
    return await stat(at.real);
  } catch {
    throw new OpError("not_found", `${at.path} is not there`);
  }
}

async function lstatOf(path: string) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whole milliseconds, which is what the contract's timestamps are and what an
 * edit compares its token against. */
function mtimeOf(stat: { mtimeMs: number }): Timestamp {
  return Math.floor(stat.mtimeMs);
}

/** A file's leading bytes, at most `limit` of them. */
async function bytesOf(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, SNIFF).includes(0);
}

/** Write a file that must not be there yet. The exclusive open is what decides
 * it: a check followed by a write would answer about the moment before. */
async function create(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new OpError("file_exists", `${basename(path)} is already there`);
    }
    throw cause;
  }
}

/** The writes of this instance, one file at a time.
 *
 * Writes to one path are chained rather than started side by side: an edit
 * reads the file, holds its token against it and replaces it, and that is one
 * step no other write to the same path may fall between. Paths do not wait on
 * each other, having nothing in common. A chain is kept only while something is
 * on it, so the map holds the paths being written and not every path ever
 * written. */
class Writes {
  readonly #chains = new Map<string, Promise<void>>();

  to<T>(path: string, write: () => Promise<T>): Promise<T> {
    const result = (this.#chains.get(path) ?? Promise.resolve()).then(write);
    // The chain carries the order, not the outcome: a write that failed is
    // answered to its own caller, and the ones behind it still go.
    const settled = result.then(
      () => {},
      () => {},
    );
    this.#chains.set(path, settled);
    void settled.then(() => {
      if (this.#chains.get(path) === settled) this.#chains.delete(path);
    });
    return result;
  }
}

/** Replace a file's content whole. The write lands beside it and is renamed
 * over it, so a reader sees either the old file or the new one and never a
 * half-written one. The name it lands under is unique to this write, so two
 * writes beside one file never share a staging file. */
async function replace(path: string, content: string): Promise<void> {
  const temporary = `${path}.ccmsg-${randomUUID()}`;
  await writeFile(temporary, content);
  try {
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary);
    throw cause;
  }
}

async function entriesOf(dir: string): Promise<DirEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry): Promise<DirEntry> => {
        const type = entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "dir"
            : entry.isFile()
              ? "file"
              : "other";
        // A symlink is reported as itself, so what is stated about it is the link
        // and never what it points at — including one pointing out of the root,
        // which is listed here and refuses to resolve everywhere else.
        const info = type === "symlink" ? undefined : await lstatOf(join(dir, entry.name));
        return {
          name: entry.name,
          type,
          ...(info?.isFile() === true ? { size: info.size } : {}),
          ...(info === undefined ? {} : { mtime_at: mtimeOf(info) }),
        };
      }),
    )
  ).sort((a, b) => a.name.localeCompare(b.name));
}

interface Terms {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

function parseQuery(query: string): Terms {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const word of query.split(/\s+/).filter((each) => each !== "")) {
    if (word.startsWith("-")) {
      const rest = word.slice(1);
      if (rest !== "") exclude.push(rest.toLowerCase());
    } else include.push(word.toLowerCase());
  }
  return { include, exclude };
}

function matches(path: string, terms: Terms): boolean {
  const haystack = path.toLowerCase();
  return (
    terms.include.every((word) => haystack.includes(word)) &&
    !terms.exclude.some((word) => haystack.includes(word))
  );
}

/** Walk one subtree, answering the paths whose own spelling matches.
 *
 * Both caps are reported the same way: the hits are the ones found, and
 * `truncated` says they are not the whole match set. Saying so is better than
 * implying these are all. */
async function find(at: Located, terms: Terms, respectGitignore: boolean) {
  const hits: FileFindHit[] = [];
  let visits = 0;
  let truncated = false;

  const walk = async (dir: string, ignored: Ignores): Promise<void> => {
    if (truncated) return;
    const here = respectGitignore ? await ignored.descend(dir) : ignored;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A folder that cannot be read contributes nothing, and a walk that
      // stopped at one would answer less than it can.
      return;
    }
    for (const entry of entries) {
      if (++visits > FIND_VISITS) {
        truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (respectGitignore && here.hides(entry.name, isDir)) continue;
      const type = entry.isSymbolicLink() ? "symlink" : isDir ? "dir" : "file";
      if (type !== "file" && type !== "dir" && type !== "symlink") continue;
      const shown = at.kind === "contained" ? relative(at.real, full) : full;
      if (matches(shown, terms)) {
        hits.push({ path: shown, type });
        if (hits.length >= FIND_HITS) {
          truncated = true;
          return;
        }
      }
      // Only real directories are descended: a symlink is answered as itself,
      // and following one would walk out of the root the walk is bounded by.
      if (isDir && !entry.isSymbolicLink()) {
        await walk(full, here);
        if (truncated) return;
      }
    }
  };

  await walk(at.real, EMPTY_IGNORES);
  return { hits, truncated };
}

/** What the repository's ignore rules hide, as far as a name-matching walk can
 * read them.
 *
 * Design rationale: this reads `.gitignore` as literal names and simple globs
 * and stops there — no negation, no anchored paths, no parent `.gitignore`
 * outside the walked subtree. The rules exist here to keep vendored trees from
 * pushing the real answer out of a capped reply, and a `node_modules/` line is
 * what does that; implementing the whole format would buy accuracy on patterns
 * that do not change which answer a person is looking for. Anything the rules
 * do not hide is answered, so an unimplemented pattern shows a file rather than
 * hiding one. */
interface Ignores {
  hides(name: string, isDir: boolean): boolean;
  descend(dir: string): Promise<Ignores>;
}

const ALWAYS_HIDDEN = new Set([".git"]);

const EMPTY_IGNORES: Ignores = makeIgnores([]);

function makeIgnores(patterns: readonly RegExp[]): Ignores {
  return {
    hides(name, _isDir) {
      if (ALWAYS_HIDDEN.has(name)) return true;
      return patterns.some((pattern) => pattern.test(name));
    },
    async descend(dir) {
      const own = await readIgnoreFile(join(dir, ".gitignore"));
      return own.length === 0 ? makeIgnores(patterns) : makeIgnores([...patterns, ...own]);
    },
  };
}

async function readIgnoreFile(file: string): Promise<RegExp[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => line.replace(/\/+$/, ""))
    .filter((line) => !line.includes("/"))
    .map(globToRegExp);
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split("")
    .map((char) => (char === "*" ? "[^/]*" : char === "?" ? "[^/]" : escapeRegExp(char)))
    .join("");
  return new RegExp(`^${body}$`);
}

function escapeRegExp(char: string): string {
  return /[\\^$.|?*+()[\]{}]/.test(char) ? `\\${char}` : char;
}
