import { basename, dirname } from "node:path";
import type { HelloSessionArgs } from "@ccmsg/protocol";

/** What a session can say about itself when it greets: the contract's shared
 * fields, each of them optional because a greeting states what it knows and
 * the instance leaves the rest unknown (contract, `SessionMetaFields`). */
export type StatedMeta = Partial<
  Pick<
    HelloSessionArgs,
    "repo" | "ws" | "cwd" | "repo_root" | "branch" | "transcript_path" | "title"
  >
>;

/** How a question is put to the version control the session works under. The
 * answer is its output, or nothing when there is none to give. Named so a test
 * can answer for a tree it never has to create. */
export type Ask = (args: readonly string[], cwd: string) => string | undefined;

const askGit: Ask = (args, cwd) => {
  try {
    const done = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    return done.exitCode === 0 ? done.stdout.toString() : undefined;
  } catch {
    // No git on this host, or a working directory that is not there to run it
    // in. Both are "nothing can be said about a repository here", which is a
    // thing a session is allowed to be.
    return undefined;
  }
};

/** What `git rev-parse` is asked, in one exchange: where the worktree begins,
 * and what is checked out in it. The two answers arrive in this order, one per
 * line. */
const WHERE = ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"] as const;

/** The name `--abbrev-ref` gives a head that is on no branch. Read as "not on
 * one" rather than as a branch called HEAD. */
const DETACHED = "HEAD";

/** Where this process is working, as a session would state it.
 *
 * `repo` and `ws` are display names for a layout, and the layout read here is
 * the one the contract describes: a repository is a container and a workspace
 * is a checkout inside it, which is what makes `repo_root` the place sibling
 * workspaces are reachable from (contract, `SessionMetaFields.repo_root`). So
 * the worktree git reports is the workspace, its parent is the repository, and
 * a tree that is not one workspace among siblings simply reads as a repository
 * with a single one.
 *
 * Outside a repository only the working directory is stated. Nothing is
 * guessed from a path that git does not stand behind — a session that names
 * neither is shown by its sid, which is a thing the instance already does.
 *
 * `transcript_path` and `title` are never derived: one is a file this process
 * has no way to find and the other is the session's own name for itself. Both
 * reach a greeting only by being handed in. */
export function statedMeta(cwd: string = process.cwd(), ask: Ask = askGit): StatedMeta {
  const answer = ask(WHERE, cwd);
  const [top, branch] = (answer ?? "").split("\n").map((line) => line.trim());
  if (top === undefined || top === "") return { cwd };
  const root = dirname(top);
  return {
    repo: basename(root),
    ws: basename(top),
    cwd,
    repo_root: root,
    ...(branch === undefined || branch === "" || branch === DETACHED ? {} : { branch }),
  };
}
