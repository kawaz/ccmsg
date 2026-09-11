import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Sid, TranscriptSubject } from "@ccmsg/protocol";
import { type Harness, HARNESS } from "../harness/index.ts";
import { OpError } from "../dispatch/index.ts";

const SUFFIX = ".jsonl";

/** What the harness names an agent's transcript with, and what it calls the
 * kind of task a teammate is. Both are its own words, read where they are
 * written rather than mirrored anywhere. */
const AGENT_PREFIX = "agent-";
const TEAMMATE_TASK = "in_process_teammate";

/** Where one harness keeps transcripts under its config home, and how a file
 * there says which session it belongs to (§3.8).
 *
 * Two facts, because the two harnesses file the same thing differently. Claude
 * Code keeps one directory per working directory and names the file after the
 * session; Codex keeps one directory per date and names the file after the
 * thread with the moment it started in front. The `depth` is how many
 * directories stand between the root and a file, which is what the walk needs
 * and what the naming does not say.
 *
 * A Codex rollout that was reverted carries a second id after the thread's own,
 * separated by `_`: the thread is the same and the file is a new one, so the
 * name still answers "which session" and that is what is read out of it. */
interface TranscriptLayout {
  readonly depth: number;
  /** The session a file belongs to, or nothing when the name is not one this
   * harness writes. */
  readonly sidOf: (name: string) => Sid | undefined;
  /** What that session's file is called, where the name follows from the sid.
   * Absent where it does not, which is what makes the walk the only way in. */
  readonly nameOf?: (sid: Sid) => string;
}

/** A session id as Claude Code names files by. Validated before it is joined
 * to a path, so a sid is a name rather than a route: no separator and no dot
 * can appear in it, which makes traversal unrepresentable rather than
 * unlikely. */
const SID = /^[0-9a-fA-F-]{8,64}$/;

/** A Codex rollout, as its recorder writes the name: the moment it opened, the
 * thread UUID, and the rollout's own id after it when the thread was reverted.
 * The thread UUID is what a sid is here (measured against codex-cli 0.153.4). */
const ROLLOUT =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})(?:_[0-9a-fA-F-]{36})?\.jsonl$/;

const LAYOUTS: Record<Harness, TranscriptLayout> = {
  claude: {
    depth: 1,
    sidOf: (name) => {
      if (!name.endsWith(SUFFIX)) return undefined;
      const sid = name.slice(0, -SUFFIX.length);
      return SID.test(sid) ? sid : undefined;
    },
    nameOf: (sid) => `${sid}${SUFFIX}`,
  },
  codex: { depth: 3, sidOf: (name) => ROLLOUT.exec(name)?.[1] },
};

/** The agent id and run id shapes the harness writes under a session's own
 * directory, and the name a teammate is addressed by. Each is validated on the
 * same footing as a sid, for the same reason: all three name a file. */
const AGENT_ID = /^a[A-Za-z0-9_-]{5,120}$/;
const RUN_ID = /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/;
const TEAMMATE = /^[A-Za-z0-9_-]{1,64}$/;

/** Which transcript an op means.
 *
 * The caller never supplies a path: a sid resolves to the file the session
 * announced, or to the one under this instance's own config home, and the
 * three optional names below resolve to files under that session's own
 * directory. Only the config home this instance answers for is ever looked in
 * (M6) — nothing searches for another one. */
export interface TranscriptFilesDeps {
  readonly configHome: string;
  /** Which harness's tree is under it (§3.8). */
  readonly harness: Harness;
  /** Where a connected session said its transcript is (§5.1). A session that
   * never greeted has none, and the walk below answers for it. */
  readonly announced: (sid: Sid) => string | undefined;
}

export class TranscriptFiles {
  constructor(private readonly deps: TranscriptFilesDeps) {}

  /** The session's own transcript, or nothing where this instance holds none.
   *
   * Two ways to the one file, in the order of what each is good for: what the
   * session announced is exact and costs no search, and the walk finds the
   * file by the identity it carries in its name for a session that never
   * greeted or is no longer running. Both stay inside this harness's own
   * transcript tree — the announced path because it was taken only if it was
   * inside it, the walk because that tree is what it walks (M6). */
  path(sid: Sid): string | undefined {
    const announced = this.deps.announced(sid);
    if (announced !== undefined && isFile(announced)) return announced;
    return this.find(sid);
  }

  /** The session's own transcript, for an op that has nothing to answer
   * without one. */
  session(sid: Sid): string {
    const found = this.path(sid);
    if (found === undefined) throw new OpError("not_found", `no transcript is held for ${sid}`);
    return found;
  }

  /** The transcript an op's arguments name: the session's own, or one of the
   * agents that ran below it.
   *
   * `agent_id` and `teammate` are two ways of naming the same kind of file and
   * cannot be combined — a request carrying both names two files and is a
   * caller's mistake rather than a choice this makes for them. */
  locate(sid: Sid, names: AgentNames = {}): string {
    const file = this.session(sid);
    if (names.agent_id !== undefined && names.teammate !== undefined) {
      throw new OpError("invalid_args", "agent_id and teammate name two different transcripts");
    }
    if (names.agent_id === undefined && names.teammate === undefined) {
      if (names.run_id !== undefined) {
        throw new OpError("invalid_args", "run_id names the run an agent_id belongs to");
      }
      return file;
    }
    const under = agentsDir(file, names.run_id);
    if (names.agent_id !== undefined) {
      return existing(join(under, `agent-${name(names.agent_id, AGENT_ID, "agent_id")}${SUFFIX}`));
    }
    return this.teammate(under, name(names.teammate ?? "", TEAMMATE, "teammate"));
  }

  /** Which standing a transcript was written from, which every item read out
   * of it states (§3.6).
   *
   * The file itself does not say whether an agent was a teammate or an errand:
   * both are marked as sidechains and both are briefed the same way. What says
   * so is the harness's own note beside the file — the same note a teammate is
   * found by name in — and `taskKind` on it is the harness stating which kind
   * of task it started. An envelope in the opening brief looks like the same
   * answer and is not one: it is text somebody wrote, and an errand handed a
   * quoted message carries it too.
   *
   * A note that is missing or unreadable leaves the question unanswered, and
   * the answer then is `sub`: an errand is the standing that claims the least —
   * nothing goes on standing, nobody is addressed by name — so a teammate read
   * as one loses a name it might have been drawn under, where the reverse would
   * have a reader write back to something that is already gone. */
  subjectOf(file: string): TranscriptSubject {
    const name = basename(file);
    if (!name.startsWith(AGENT_PREFIX) || !name.endsWith(SUFFIX)) return "main";
    let note: unknown;
    try {
      note = JSON.parse(
        readFileSync(join(dirname(file), `${name.slice(0, -SUFFIX.length)}.meta.json`), "utf8"),
      );
    } catch {
      return "sub";
    }
    const kind = (note as { taskKind?: unknown } | null)?.taskKind;
    return kind === TEAMMATE_TASK ? "team" : "sub";
  }

  /** A teammate's transcript, found by the name it is addressed by.
   *
   * The name a teammate carries in conversation is not its filename, so the
   * directory's own records are read for it rather than the name being
   * substituted into a path. */
  private teammate(under: string, wanted: string): string {
    let names: string[];
    try {
      names = readdirSync(under);
    } catch {
      throw new OpError("not_found", `no agent has run under this session`);
    }
    for (const each of names) {
      if (!each.endsWith(".meta.json")) continue;
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(join(under, each), "utf8"));
      } catch {
        continue;
      }
      const named = (document as { name?: unknown } | null)?.name;
      if (named !== wanted) continue;
      return existing(join(under, `${each.slice(0, -".meta.json".length)}${SUFFIX}`));
    }
    throw new OpError("not_found", `no teammate of this session is addressed as ${wanted}`);
  }

  /** Every transcript under this instance's config home, newest first.
   *
   * The one enumeration a search and a fork sweep both start from. It states
   * the file and what a `stat` already said about it, so neither has to stat
   * again to decide whether to open it. */
  all(): TranscriptFile[] {
    const layout = LAYOUTS[this.deps.harness];
    const found: TranscriptFile[] = [];
    for (const dir of directories(this.#root(), layout.depth)) {
      for (const entry of names(dir)) {
        const sid = layout.sidOf(entry);
        if (sid === undefined) continue;
        const file = join(dir, entry);
        const stat = statOf(file);
        if (stat === undefined) continue;
        found.push({
          sid,
          file,
          // Only a layout that files by working directory has one to state,
          // and the field is a prefilter: a tree that says nothing about where
          // a session ran narrows nothing, and the transcript's own `cwd`
          // decides as it already does.
          ...(this.deps.harness === "claude" ? { project: basename(dir) } : {}),
          size: stat.size,
          created_at: Math.round(stat.birthtimeMs || stat.ctimeMs),
          updated_at: Math.round(stat.mtimeMs),
        });
      }
    }
    found.sort((a, b) => b.updated_at - a.updated_at || a.file.localeCompare(b.file));
    return found;
  }

  /** The root of this harness's transcript tree, which is the boundary every
   * path below is inside of (M6). */
  #root(): string {
    return join(this.deps.configHome, HARNESS[this.deps.harness].transcripts);
  }

  /** The session's file, found by the identity its name carries.
   *
   * A layout whose name follows from the sid is joined rather than searched,
   * which is one `stat` per directory instead of a listing; one whose name
   * carries more than the sid is walked, because the rest of the name is
   * exactly what this does not know. */
  private find(sid: Sid): string | undefined {
    const layout = LAYOUTS[this.deps.harness];
    const dirs = directories(this.#root(), layout.depth);
    const nameOf = layout.nameOf;
    if (nameOf !== undefined) {
      if (!SID.test(sid)) return undefined;
      for (const dir of dirs) {
        const file = join(dir, nameOf(sid));
        if (isFile(file)) return file;
      }
      return undefined;
    }
    for (const dir of dirs) {
      for (const entry of names(dir)) {
        if (layout.sidOf(entry) === sid && isFile(join(dir, entry))) return join(dir, entry);
      }
    }
    return undefined;
  }
}

/** Every directory transcripts sit in, at the depth the layout files them at.
 *
 * Names are read rather than dates computed: what is there is what the harness
 * wrote, and a tree with a directory nobody expected is one whose files are
 * still found. */
function directories(root: string, depth: number): string[] {
  let level = [root];
  for (let step = 0; step < depth; step += 1) {
    level = level.flatMap((dir) => names(dir).map((entry) => join(dir, entry)));
  }
  return level;
}

export interface AgentNames {
  readonly agent_id?: string;
  readonly run_id?: string;
  readonly teammate?: string;
}

/** One transcript on disk, with what the enumeration already learned of it. */
export interface TranscriptFile {
  readonly sid: Sid;
  readonly file: string;
  /** The project directory's name, which is the working directory flattened.
   * A lossy spelling — separators and dots all become dashes — so it prefilters
   * a search and never decides it. Absent where the harness files transcripts
   * by something other than the working directory, which leaves nothing to
   * prefilter on. */
  readonly project?: string;
  readonly size: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Where the agents of one session write, beside its own transcript. */
function agentsDir(sessionFile: string, runId?: string): string {
  const dir = join(dirname(sessionFile), basename(sessionFile, SUFFIX), "subagents");
  if (runId === undefined) return dir;
  return join(dir, "workflows", name(runId, RUN_ID, "run_id"));
}

/** One path segment, checked against the shape its kind has. The check runs
 * before the join, so a name that could leave the directory never becomes part
 * of a path at all. */
function name(value: string, shape: RegExp, field: string): string {
  if (!shape.test(value)) throw new OpError("invalid_args", `${field} is not a name of that kind`);
  return value;
}

function existing(file: string): string {
  if (!isFile(file)) throw new OpError("not_found", "no transcript is held for that agent");
  return file;
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statOf(file: string) {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

function isFile(file: string): boolean {
  return statOf(file) !== undefined;
}
