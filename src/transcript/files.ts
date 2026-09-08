import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Sid } from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";

/** Where the harness keeps transcripts under a config home: one directory per
 * working directory, one `<sid>.jsonl` in it. */
const PROJECTS = "projects";
const SUFFIX = ".jsonl";

/** A session id as the harness names files by. Validated before it is joined
 * to a path, so a sid is a name rather than a route: no separator and no dot
 * can appear in it, which makes traversal unrepresentable rather than
 * unlikely. */
const SID = /^[0-9a-fA-F-]{8,64}$/;

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
  /** Where a connected session said its transcript is (§5.1). A session that
   * never greeted has none, and the walk below answers for it. */
  readonly announced: (sid: Sid) => string | undefined;
}

export class TranscriptFiles {
  constructor(private readonly deps: TranscriptFilesDeps) {}

  /** The session's own transcript. */
  session(sid: Sid): string {
    const announced = this.deps.announced(sid);
    if (announced !== undefined && isFile(announced)) return announced;
    const found = this.find(sid);
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
    const found: TranscriptFile[] = [];
    const projects = join(this.deps.configHome, PROJECTS);
    for (const project of names(projects)) {
      const dir = join(projects, project);
      for (const entry of names(dir)) {
        if (!entry.endsWith(SUFFIX)) continue;
        const sid = entry.slice(0, -SUFFIX.length);
        if (!SID.test(sid)) continue;
        const file = join(dir, entry);
        const stat = statOf(file);
        if (stat === undefined) continue;
        found.push({
          sid,
          file,
          project,
          size: stat.size,
          created_at: Math.round(stat.birthtimeMs || stat.ctimeMs),
          updated_at: Math.round(stat.mtimeMs),
        });
      }
    }
    found.sort((a, b) => b.updated_at - a.updated_at || a.file.localeCompare(b.file));
    return found;
  }

  private find(sid: Sid): string | undefined {
    if (!SID.test(sid)) return undefined;
    const projects = join(this.deps.configHome, PROJECTS);
    for (const project of names(projects)) {
      const file = join(projects, project, `${sid}${SUFFIX}`);
      if (isFile(file)) return file;
    }
    return undefined;
  }
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
   * a search and never decides it. */
  readonly project: string;
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
