import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FileKind, Role, Sid } from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";

/** The three allowlists one session reaches files through.
 *
 * They are the session's own facts, not the caller's: the browsable root is
 * where the session works, the workspace folders are what its editor names, and
 * the external files are the paths its transcript named outside both. Whoever
 * holds those facts states them here, and a session that stated none is a
 * session no path is admitted for — nothing is guessed from a neighbouring
 * value. */
export interface SessionRoots {
  /** Where `contained` paths are relative to: the repository container the
   * session greeted with, or its working directory. Absent when the session
   * greeted with neither, which admits no contained path at all. */
  readonly root?: string;
  /** Where `file_write` puts a file. Kept apart from `root`, which may be the
   * container above the working copy. */
  readonly cwd?: string;
  /** Absolute folder paths, each admitting its whole subtree. */
  readonly workspace_folders: readonly string[];
  /** Absolute file paths, each admitting exactly itself. */
  readonly external_files: readonly string[];
}

/** Who states a session's allowlists. */
export interface RootsSource {
  roots(sid: Sid): SessionRoots | undefined;
}

/** One path, decided.
 *
 * `real` is what the filesystem calls it and what every later operation uses;
 * `path` is the shape the kind implies, which is what the reply states back. */
export interface Located {
  readonly kind: FileKind;
  readonly real: string;
  readonly path: string;
  /** The same path with its own last segment unresolved: what was named, not
   * what it points at. An op that acts on the name rather than on the file —
   * `file_delete`, which unlinks a name — asks what kind of thing was named,
   * and only this distinguishes a file from a symlink to one. */
  readonly named: string;
}

/** The whole file-access decision, for every op that names a path.
 *
 * One function rather than a check per handler: a handler starts from "this
 * path may be reached" the way it already starts from "this call is allowed",
 * so the three surfaces, the symlink resolution behind them and the visible
 * range a caller has are decided in one place and cannot come apart.
 *
 * `Viewer` is that visible range, and it is where the role of a `scope: "role"`
 * op arrives (§3.2): a session reads its own session's files, a person reads
 * any session's, and a role the rule does not name reaches nothing rather than
 * being guessed at. An op the attribute table gives no `scope` states no role
 * here, and needs none — dispatch has already settled who may call it. */
export interface Viewer {
  /** Present only for an op the attribute table marks `scope: "role"`, which
   * is the one route by which a role reaches an implementation (§3.2). */
  readonly role?: Role;
  /** The session the connection speaks for, when it speaks for one. */
  readonly sid?: Sid;
}

export class Containment {
  constructor(private readonly source: RootsSource) {}

  /** A path named by kind, as an op's arguments give it. */
  locate(args: PathArgs, viewer: Viewer = {}): Located {
    const roots = this.rootsFor(args.sid, viewer);
    const named = this.absolute(args, roots);
    const real = canonical(named);
    return { ...this.admit(args.kind, real, roots), named };
  }

  /** An absolute path with no kind: which surface admits it, if any.
   *
   * The surfaces are tried in the order the contract states, and the answer is
   * one value for every refusal — outside the allowlists, or simply not there —
   * so a caller cannot learn from it whether a path it may not read exists. */
  identify(sid: Sid, path: string, viewer: Viewer = {}): Located | undefined {
    let roots: SessionRoots;
    try {
      roots = this.rootsFor(sid, viewer);
    } catch {
      return undefined;
    }
    if (!isAbsolute(path)) return undefined;
    const named = resolve(path);
    const real = canonical(named);
    for (const kind of KINDS) {
      try {
        return { ...this.admit(kind, real, roots), named };
      } catch {
        // The next surface may admit it; running out of surfaces is the miss.
      }
    }
    return undefined;
  }

  /** Where `file_write` writes, which is the one destination no kind names: the
   * session's working directory, and within it the inbox the destination is
   * fixed to (DR-0019). A name that leaves the inbox is refused as unwritable
   * rather than as forbidden — the path is reachable, and only writing there
   * is not. */
  inbox(sid: Sid, path: string, viewer: Viewer = {}): Located {
    const roots = this.rootsFor(sid, viewer);
    const cwd = roots.cwd;
    if (cwd === undefined || !isAbsolute(cwd)) {
      throw new OpError("path_forbidden", `${sid} states no working directory to write into`);
    }
    const base = canonical(cwd);
    const named = resolve(base, path);
    const real = canonical(named);
    const inbox = join(base, INBOX);
    if (!within(real, inbox)) {
      throw new OpError("path_not_writable", `only ${INBOX}/ takes a written file`);
    }
    return { kind: "contained", real, named, path: relativeTo(base, real) };
  }

  /** The directory a listing or a walk starts from. */
  root(args: DirArgs, viewer: Viewer = {}): Located {
    return this.locate({ sid: args.sid, kind: args.kind, path: args.path ?? "" }, viewer);
  }

  private rootsFor(sid: Sid, viewer: Viewer): SessionRoots {
    if (!sees(sid, viewer)) {
      throw new OpError(
        "path_forbidden",
        `the files of ${sid} are outside this connection's range`,
      );
    }
    const roots = this.source.roots(sid);
    if (roots === undefined) {
      throw new OpError("path_forbidden", `nothing is known about the files of ${sid}`);
    }
    return roots;
  }

  /** Turn an op's `path` into an absolute one, in the shape its kind states. */
  private absolute(args: PathArgs, roots: SessionRoots): string {
    if (args.kind === "contained") {
      const root = roots.root;
      if (root === undefined || !isAbsolute(root)) {
        throw new OpError("path_forbidden", "this session states no root to be contained by");
      }
      return resolve(canonical(root), `.${sep}${args.path}`);
    }
    if (!isAbsolute(args.path)) {
      throw new OpError("path_forbidden", `a ${args.kind} path is absolute`);
    }
    return args.path;
  }

  /** Whether a resolved path is inside the surface it claims. The check runs on
   * what the filesystem resolved, so a symlink pointing out of a root is
   * refused however it was spelled (DR-0008 §3). */
  private admit(kind: FileKind, real: string, roots: SessionRoots): Omit<Located, "named"> {
    if (kind === "contained") {
      const root = roots.root === undefined ? undefined : canonical(roots.root);
      if (root === undefined || !within(real, root)) {
        throw new OpError("path_forbidden", "the path is outside the session's root");
      }
      return { kind, real, path: relativeTo(root, real) };
    }
    if (kind === "workspace") {
      const folder = roots.workspace_folders.find((each) => within(real, canonical(each)));
      if (folder === undefined) {
        throw new OpError("path_forbidden", "the path is in no workspace folder of this session");
      }
      return { kind, real, path: real };
    }
    // `external` admits exactly the files the transcript named, so both sides
    // of the comparison go through this same resolution (DR-0024 §3.2) — a
    // path spelled through a symlink and the same file spelled directly are
    // one entry, and a path since replaced by a symlink resolves elsewhere and
    // is no longer in the list.
    const named = roots.external_files.some((each) => canonical(each) === real);
    if (!named) {
      throw new OpError("path_forbidden", "the path is not one this session's transcript named");
    }
    return { kind, real, path: real };
  }
}

/** Which sessions a caller may name, for every `scope: "role"` op.
 *
 * A session sees the session it speaks for, a person sees every session. A
 * role the rule does not name sees nothing — the attribute table decides who
 * may call an op, and a role it later admits is one this rule has to be told
 * about rather than one it guesses a range for. An op with no `scope` states
 * no role, and has none to narrow by: dispatch already settled who may call it.
 *
 * The visible range is one function rather than one per op: `transcript_read`
 * and the file ops narrow by the same rule, and two spellings of it could come
 * apart while both still passing their own tests. */
export function sees(sid: Sid, viewer: Viewer): boolean {
  switch (viewer.role) {
    case undefined:
      return true;
    case "user":
      return true;
    case "session":
      return viewer.sid === sid;
    default:
      return false;
  }
}

export interface PathArgs {
  readonly sid: Sid;
  readonly kind: FileKind;
  readonly path: string;
}

export interface DirArgs {
  readonly sid: Sid;
  readonly kind: FileKind;
  readonly path?: string;
}

/** The directory `file_write` writes into, relative to the working directory. */
const INBOX = join("docs", "inbox");

const KINDS = ["contained", "workspace", "external"] as const;

/** What the filesystem calls a path, whether or not it is there yet.
 *
 * A path that does not exist is resolved as far as its parent and given its own
 * last segment back, so a file about to be created is decided by where it would
 * land rather than being refused for not being there. A parent that does not
 * resolve either leaves the path as written, which no surface admits. */
export function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    try {
      return join(realpathSync(parent), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/** Whether a resolved path is the root or below it. Shared with the launcher,
 * whose roots come from config rather than from a session: what "inside" means
 * is the same question, and two spellings of it could come apart. */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A contained path as the contract states it: relative to the root, with the
 * root itself the empty string. */
function relativeTo(root: string, real: string): string {
  return real === root ? "" : real.slice(root.length + 1);
}
