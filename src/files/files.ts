import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
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
  FileStatBatchArgs,
  FileStatBatchResult,
  FileStatEntry,
  FileWriteArgs,
  FileWriteResult,
  Timestamp,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../dispatch/index.ts";
import type { Containment, Located, Viewer } from "./containment.ts";

/** How much of a file `file_read` carries. Larger files are answered with their
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
export function fileHandlers(paths: Containment) {
  const viewer = (input: HandlerInput): Viewer => ({ role: input.role, sid: input.identity?.sid });

  return {
    dir_list: (input: HandlerInput): DirListResult => {
      const args = input.args as unknown as DirListArgs;
      const at = paths.root(args, viewer(input));
      const stat = existing(at);
      if (!stat.isDirectory()) throw new OpError("not_found", `${args.path ?? ""} is not a folder`);
      return { sid: args.sid, path: at.path, entries: entriesOf(at.real) };
    },

    file_read: (input: HandlerInput): FileReadResult => {
      const args = input.args as unknown as FileReadArgs;
      const at = paths.locate(args, viewer(input));
      const stat = existing(at);
      if (!stat.isFile()) throw new OpError("not_found", `${args.path} is not a file`);
      const head = readFileSync(at.real).subarray(0, READ_LIMIT);
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

    file_write: (input: HandlerInput): FileWriteResult => {
      const args = input.args as unknown as FileWriteArgs;
      const at = paths.inbox(args.sid, args.path, viewer(input));
      // The inbox takes new notes, so an existing name is refused rather than
      // replaced; the folder itself is made, since a repository that has never
      // had one is exactly where the first note goes (DR-0019 §2.1).
      mkdirSync(dirname(at.real), { recursive: true });
      create(at.real, args.content);
      return { sid: args.sid, path: at.path };
    },

    file_create: (input: HandlerInput): FileCreateResult => {
      const args = input.args as unknown as FileCreateArgs;
      const at = paths.locate(args, viewer(input));
      const parent = dirname(at.real);
      if (!isDirectory(parent)) {
        throw new OpError("not_found", `${args.path} has no folder to be created in`);
      }
      create(at.real, args.content);
      return { sid: args.sid, path: at.path };
    },

    file_edit: (input: HandlerInput): FileEditResult => {
      const args = input.args as unknown as FileEditArgs;
      const at = paths.locate(args, viewer(input));
      const stat = existing(at);
      if (!stat.isFile()) throw new OpError("not_found", `${args.path} is not a file`);
      if (isBinary(head(at.real))) {
        throw new OpError("not_a_text_file", `${args.path} holds binary content`);
      }
      if (mtimeOf(stat) !== args.expected_mtime_at || stat.size !== args.expected_size) {
        throw new OpError("file_conflict", `${args.path} changed since it was read`);
      }
      replace(at.real, args.content);
      const after = statSync(at.real);
      return { sid: args.sid, path: at.path, size: after.size, mtime_at: mtimeOf(after) };
    },

    file_delete: (input: HandlerInput): FileDeleteResult => {
      const args = input.args as unknown as FileDeleteArgs;
      const at = paths.locate(args, viewer(input));
      // What is unlinked is what is named, so this reads the name itself rather
      // than what it resolves to: a symlink is refused as the wrong kind of
      // thing instead of taking its target's answer.
      const stat = lstatOf(at.real);
      if (stat === undefined) throw new OpError("not_found", `${args.path} is not there`);
      if (!stat.isFile()) {
        throw new OpError("path_forbidden", `${args.path} is not a plain file`);
      }
      unlinkSync(at.real);
      return { sid: args.sid, path: at.path };
    },

    file_find: (input: HandlerInput): FileFindResult => {
      const args = input.args as unknown as FileFindArgs;
      const at = paths.root(
        { sid: args.sid, kind: args.kind, ...(args.root === undefined ? {} : { path: args.root }) },
        viewer(input),
      );
      const terms = parseQuery(args.query);
      // A query with nothing to include matches nothing rather than the whole
      // tree, so a cleared search box costs no walk at all.
      if (terms.include.length === 0) return { sid: args.sid, hits: [], truncated: false };
      const walk = find(at, terms, args.respect_gitignore ?? true);
      return { sid: args.sid, hits: walk.hits, truncated: walk.truncated };
    },

    file_stat_batch: (input: HandlerInput): FileStatBatchResult => {
      const args = input.args as unknown as FileStatBatchArgs;
      const results = args.paths.map((path): FileStatEntry | null => {
        const at = paths.identify(args.sid, path, viewer(input));
        if (at === undefined || !isFile(at.real)) return null;
        return { kind: at.kind, path: at.path };
      });
      return { results };
    },
  };
}

/** The file a located path names, or the contract's word for "not there". */
function existing(at: Located) {
  try {
    return statSync(at.real);
  } catch {
    throw new OpError("not_found", `${at.path} is not there`);
  }
}

function lstatOf(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whole milliseconds, which is what the contract's timestamps are and what an
 * edit compares its token against. */
function mtimeOf(stat: { mtimeMs: number }): Timestamp {
  return Math.floor(stat.mtimeMs);
}

function head(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SNIFF);
    const read = readSync(fd, buffer, 0, SNIFF, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, SNIFF).includes(0);
}

/** Write a file that must not be there yet. The exclusive open is what decides
 * it: a check followed by a write would answer about the moment before. */
function create(path: string, content: string): void {
  try {
    writeFileSync(path, content, { flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new OpError("file_exists", `${basename(path)} is already there`);
    }
    throw cause;
  }
}

/** Replace a file's content whole. The write lands beside it and is renamed
 * over it, so a reader sees either the old file or the new one and never a
 * half-written one. */
function replace(path: string, content: string): void {
  const temporary = `${path}.ccmsg-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content);
  try {
    renameSync(temporary, path);
  } catch (cause) {
    unlinkSync(temporary);
    throw cause;
  }
}

function entriesOf(dir: string): DirEntry[] {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry): DirEntry => {
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
      const stat = type === "symlink" ? undefined : lstatOf(join(dir, entry.name));
      return {
        name: entry.name,
        type,
        ...(stat?.isFile() === true ? { size: stat.size } : {}),
        ...(stat === undefined ? {} : { mtime_at: mtimeOf(stat) }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
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
function find(at: Located, terms: Terms, respectGitignore: boolean) {
  const hits: FileFindHit[] = [];
  let visits = 0;
  let truncated = false;

  const walk = (dir: string, ignored: Ignores): void => {
    if (truncated) return;
    const here = respectGitignore ? ignored.descend(dir) : ignored;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
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
        walk(full, here);
        if (truncated) return;
      }
    }
  };

  walk(at.real, EMPTY_IGNORES);
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
  descend(dir: string): Ignores;
}

const ALWAYS_HIDDEN = new Set([".git"]);

const EMPTY_IGNORES: Ignores = makeIgnores([]);

function makeIgnores(patterns: readonly RegExp[]): Ignores {
  return {
    hides(name, _isDir) {
      if (ALWAYS_HIDDEN.has(name)) return true;
      return patterns.some((pattern) => pattern.test(name));
    },
    descend(dir) {
      const own = readIgnoreFile(join(dir, ".gitignore"));
      return own.length === 0 ? makeIgnores(patterns) : makeIgnores([...patterns, ...own]);
    },
  };
}

function readIgnoreFile(file: string): RegExp[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
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
