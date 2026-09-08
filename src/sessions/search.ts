import { readFileSync } from "node:fs";
import { parse, sep } from "node:path";
import type {
  InstanceId,
  SessionSearchArgs,
  SessionSearchHit,
  SessionSearchMatch,
  SessionSearchResult,
} from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import { readRecord, type TranscriptFile, type TranscriptFiles } from "../transcript/index.ts";

/** What one search may read, and what it may answer with.
 *
 * A search walks transcripts that were never opened for it and cannot know how
 * many will match, so both ends are bounded: the bytes stop a query that
 * matches nothing from reading a whole config home, and the hits stop one that
 * matches everything from becoming a payload nobody can use. Reaching either
 * is `truncated` rather than an error — the hits found are still hits. */
const SCAN_BUDGET_BYTES = 64 * 1024 * 1024;
const HITS = 50;
/** What one hit shows of what it matched. Enough to recognise the passage;
 * the transcript itself is one `transcript_read` away. */
const MATCHES_PER_HIT = 5;
const MATCH_CHARS = 400;

export interface SearchDeps {
  readonly self: InstanceId;
  /** The one config home this instance answers for (M6). */
  readonly configHome: string;
  readonly files: TranscriptFiles;
}

/** Search the transcripts of sessions that have run on this instance.
 *
 * Two stages, because opening every transcript to answer a query about one is
 * the cost this op is bounded against: the enumeration filters on what a
 * directory listing and a `stat` already say — the session id, the working
 * directory as the project directory spells it, when the file was last touched
 * — and only what survives that is read. */
export function search(args: SessionSearchArgs, deps: SearchDeps): SessionSearchResult {
  if ((args.config_dirs ?? [deps.configHome]).every((dir) => dir !== deps.configHome)) {
    // Every config home the caller named is one this instance does not know,
    // which the contract says to ignore — leaving nothing to search.
    return { hits: [], truncated: false };
  }
  const clauses = compile(args);
  const sid = args.sid?.toLowerCase();
  const cwdWords = (args.cwd ?? "").trim().split(/\s+/).filter(Boolean);
  const since = args.modified_within_ms === undefined ? 0 : Date.now() - args.modified_within_ms;
  const wanted = { user: args.target_user ?? true, agent: args.target_agent ?? true };

  const hits: SessionSearchHit[] = [];
  let budget = SCAN_BUDGET_BYTES;
  let truncated = false;
  for (const candidate of deps.files.all()) {
    if (sid !== undefined && !candidate.sid.toLowerCase().includes(sid)) continue;
    if (candidate.updated_at < since) continue;
    if (!looksLike(candidate.project, cwdWords)) continue;
    if (hits.length >= HITS || budget <= 0) {
      truncated = true;
      break;
    }
    budget -= candidate.size;
    const hit = read(candidate, clauses, wanted, deps);
    // The working directory the project directory only approximates: a hit is
    // kept when the transcript's own `cwd` holds every word asked for.
    if (hit !== undefined && holds(hit.cwd, cwdWords)) hits.push(hit);
  }
  return { hits, truncated };
}

/** One clause of a query: the terms that must all appear for it to match.
 *
 * Clauses are ORed and the terms within one are ANDed, which is what lets a
 * caller ask for two unrelated passages in one search. A query stating nothing
 * matches every record, so a search by working directory alone is a search. */
type Clause = (text: string) => boolean;

function compile(args: SessionSearchArgs): Clause[] {
  const query = args.query?.trim();
  if (query === undefined || query === "") return [];
  const sensitive = args.case_sensitive === true;
  return query
    .split("\n")
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "")
    .map((clause) => {
      if (args.regex === true) {
        let matcher: RegExp;
        try {
          matcher = new RegExp(clause, sensitive ? "" : "i");
        } catch (cause) {
          throw new OpError(
            "invalid_args",
            `${clause} is not a regular expression: ${String(cause)}`,
          );
        }
        return (text: string) => matcher.test(text);
      }
      const terms = clause.split(/\s+/).map((term) => (sensitive ? term : term.toLowerCase()));
      return (text: string) => {
        const against = sensitive ? text : text.toLowerCase();
        return terms.every((term) => against.includes(term));
      };
    });
}

/** Read one transcript, and state it as a hit when it matched.
 *
 * The pass is one: the records that carry the query also carry the working
 * directory, the title and what the session last ran as, so a hit is built
 * from the reading that decided it rather than from a second one. */
function read(
  candidate: TranscriptFile,
  clauses: readonly Clause[],
  wanted: { user: boolean; agent: boolean },
  deps: SearchDeps,
): SessionSearchHit | undefined {
  let text: string;
  try {
    text = readFileSync(candidate.file, "utf8");
  } catch {
    // Gone since it was listed, which is a session that ended mid-search.
    return undefined;
  }
  const matches: SessionSearchMatch[] = [];
  let cwd: string | undefined;
  let title: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let createdAt: number | undefined;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const record = readRecord(line);
    if (record === undefined) continue;
    cwd ??= record.cwd;
    createdAt ??= record.said_at;
    if (record.title !== undefined) title = record.title;
    // What the session runs as is a property of its latest turn rather than of
    // its first: a session whose model was changed mid-run resumes as what it
    // is now. Sidechain rows are a subagent's own turns and say nothing of it.
    if (!record.sidechain && record.model !== undefined) {
      model = record.model;
      effort = record.effort;
    }
    if (matches.length >= MATCHES_PER_HIT) continue;
    const said = record.text;
    if (said === undefined || record.said_by === undefined || !wanted[record.said_by]) continue;
    if (!says(said, clauses)) continue;
    matches.push({
      role: record.said_by,
      text: said.length > MATCH_CHARS ? `${said.slice(0, MATCH_CHARS)}…` : said,
      ...(record.said_at === undefined ? {} : { said_at: record.said_at }),
    });
  }
  if (clauses.length > 0 && matches.length === 0) return undefined;
  const location = repoLocation(cwd);
  return {
    sid: candidate.sid,
    instance: deps.self,
    config_dir: deps.configHome,
    file: candidate.file,
    ...(cwd === undefined ? {} : { cwd }),
    ...location,
    ...(title === undefined ? {} : { title }),
    created_at: createdAt ?? candidate.created_at,
    updated_at: candidate.updated_at,
    size: candidate.size,
    matches,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/** Whether any clause matches. A query stating no clause matches everything,
 * which is what makes a search by working directory alone a search. */
function says(text: string, clauses: readonly Clause[]): boolean {
  return clauses.length === 0 || clauses.some((clause) => clause(text));
}

/** Whether the project directory could be the working directory asked for.
 *
 * The harness flattens a working directory into one name, and the flattening
 * is lossy — separators, dots and underscores all become dashes — so this only
 * narrows what is opened. What decides a hit is the transcript's own `cwd`. */
function looksLike(project: string, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const flat = flatten(project);
  return words.every((word) => flat.includes(flatten(word)));
}

function holds(cwd: string | undefined, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  if (cwd === undefined) return false;
  const flat = flatten(cwd);
  return words.every((word) => flat.includes(flatten(word)));
}

function flatten(value: string): string {
  return value.toLowerCase().replace(/[-/._\s]/g, "");
}

/** `owner/repo` and the workspace within it, when the working directory
 * follows the layout that states them. A directory that does not is reported
 * without them rather than with a guess. */
function repoLocation(cwd: string | undefined): { repo?: string; ws?: string } {
  if (cwd === undefined) return {};
  const root = parse(cwd).root;
  const parts = cwd.slice(root.length).split(sep).filter(Boolean);
  for (let at = parts.length - 1; at >= 0; at--) {
    if (parts[at] !== "repos" || at + 3 >= parts.length) continue;
    const workspace = parts.slice(at + 4);
    return {
      repo: `${parts[at + 2]}/${parts[at + 3]}`,
      ...(workspace.length === 0 ? {} : { ws: workspace.join(sep) }),
    };
  }
  return {};
}
