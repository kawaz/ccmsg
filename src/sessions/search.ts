import { readFile } from "node:fs/promises";
import { parse, sep } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  InstanceId,
  SessionSearchArgs,
  SessionSearchHit,
  SessionSearchMatch,
  SessionSearchResult,
} from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import { readRecord, type TranscriptFile, type TranscriptFiles } from "../transcript/index.ts";
import { breathe, due } from "../transcript/scan.ts";

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
 * the transcript itself is one `transcript.read` away. */
const MATCHES_PER_HIT = 5;
const MATCH_CHARS = 400;

/** The longest one clause may be. A query is something a person types, and the
 * pattern's own size is one of the things that decides what matching it costs;
 * past this it is a program rather than a query. */
const MAX_CLAUSE_CHARS = 1000;

/** What a query's regular expressions may spend on matching, over the whole
 * search.
 *
 * The contract lets a caller state a regular expression and says nothing about
 * which ones, so the patterns that backtrack super-linearly are admitted — and
 * they are not only the crafted ones: `[a-z]+ing` over records of ordinary
 * prose is quadratic in each record's length, and measured here it spends 86
 * seconds on the scan budget below where a literal or an alternation spends
 * 7 to 12 milliseconds on the same bytes. Two seconds is two orders of
 * magnitude above what a well-formed query needs, and it is the figure this
 * op's own condition is written in: an instance answering something else must
 * not be kept waiting past it.
 *
 * It is a deadline rather than an allowance spent between calls, because a
 * `RegExp` cannot be interrupted: what the budget buys is the moment the
 * thread running it is ended. Reaching it is `truncated`, which is what every
 * other cap on this op is. */
const REGEX_BUDGET_MS = 2000;

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
export async function search(
  args: SessionSearchArgs,
  deps: SearchDeps,
): Promise<SessionSearchResult> {
  if ((args.config_dirs ?? [deps.configHome]).every((dir) => dir !== deps.configHome)) {
    // Every config home the caller named is one this instance does not know,
    // which the contract says to ignore — leaving nothing to search.
    return { hits: [], truncated: false };
  }
  const query = compile(args);
  const sid = args.sid?.toLowerCase();
  const cwdWords = (args.cwd ?? "").trim().split(/\s+/).filter(Boolean);
  const since = args.modified_within_ms === undefined ? 0 : Date.now() - args.modified_within_ms;
  const wanted = { user: args.target_user ?? true, agent: args.target_agent ?? true };

  const hits: SessionSearchHit[] = [];
  let budget = SCAN_BUDGET_BYTES;
  let truncated = false;
  try {
    for (const candidate of await deps.files.all()) {
      if (sid !== undefined && !candidate.sid.toLowerCase().includes(sid)) continue;
      if (candidate.updated_at < since) continue;
      if (!looksLike(candidate.project, cwdWords)) continue;
      // A query that has given up leaves nothing that could still match, so
      // the rest of the walk would read transcripts to decide nothing.
      if (hits.length >= HITS || budget <= 0 || query.spent) {
        truncated = true;
        break;
      }
      budget -= candidate.size;
      const hit = await read(candidate, query, wanted, deps);
      // The working directory the project directory only approximates: a hit
      // is kept when the transcript's own `cwd` holds every word asked for.
      if (hit !== undefined && holds(hit.cwd, cwdWords)) hits.push(hit);
    }
  } finally {
    query.close();
  }
  // A query that ran out of time answered about fewer records than it was
  // asked about, whether or not the walk itself reached an end.
  return { hits, truncated: truncated || query.spent };
}

/** What a query does to the texts a transcript holds.
 *
 * Asked of a whole file's candidate rows at once rather than of one row at a
 * time: matching is where a search spends itself, and when it happens on
 * another thread the crossing costs more than the comparison does. One
 * crossing per file keeps that cost proportional to what is read.
 *
 * A query stating nothing matches every record, so a search by working
 * directory alone is a search. */
interface Query {
  /** Whether this query states anything to match. */
  readonly stated: boolean;
  /** The query gave up part-way, so what it did not match it did not decide
   * about. */
  readonly spent: boolean;
  /** Which of these texts match, in order, at most `want` of them. */
  matching(texts: readonly string[], want: number): Promise<readonly number[]>;
  /** Let go of whatever the query was holding. */
  close(): void;
}

/** A query that states nothing: every text matches, and the first `want` of
 * them are what a hit shows. */
const EVERYTHING: Query = {
  stated: false,
  spent: false,
  matching: (texts, want) => Promise.resolve(indexes(Math.min(texts.length, want))),
  close: () => {},
};

function indexes(count: number): number[] {
  return Array.from({ length: count }, (_, at) => at);
}

/** Clauses are ORed and the terms within one are ANDed, which is what lets a
 * caller ask for two unrelated passages in one search. Substring matching is
 * linear in what it is given and the bytes it may be given are already
 * bounded, so it is done here rather than anywhere else. */
class Terms implements Query {
  readonly stated = true;
  readonly spent = false;

  constructor(private readonly clauses: readonly ((text: string) => boolean)[]) {}

  matching(texts: readonly string[], want: number): Promise<readonly number[]> {
    const found: number[] = [];
    for (let at = 0; at < texts.length && found.length < want; at += 1) {
      const text = texts[at] as string;
      if (this.clauses.some((clause) => clause(text))) found.push(at);
    }
    return Promise.resolve(found);
  }

  close(): void {}
}

/** The person's regular expressions, matched on a thread of their own.
 *
 * The budget is kept here because it can only be kept here: the thread doing
 * the matching is inside a call that does not return, and ending it is the one
 * thing that stops it. What that buys is that an instance answering something
 * else is never behind a match — the op that asked is, and it is told so as
 * `truncated`. */
class Patterns implements Query {
  readonly stated = true;
  #spent = false;
  #worker: Worker | undefined;
  #left = REGEX_BUDGET_MS;

  constructor(private readonly patterns: readonly RegExp[]) {}

  get spent(): boolean {
    return this.#spent;
  }

  async matching(texts: readonly string[], want: number): Promise<readonly number[]> {
    if (this.#spent || texts.length === 0) return [];
    const worker = (this.#worker ??= new Worker(new URL("./search-worker.ts", import.meta.url), {
      workerData: {
        patterns: this.patterns.map((each) => ({ source: each.source, flags: each.flags })),
      },
    }));
    const at = performance.now();
    try {
      return await this.#within(worker, { texts, want });
    } finally {
      this.#left -= performance.now() - at;
    }
  }

  /** One ask, answered or given up on.
   *
   * The deadline is a timer rather than a reading taken afterwards: a match
   * that has not come back is exactly the case this bounds, and there is
   * nothing to read while it is still running. */
  #within(worker: Worker, ask: { texts: readonly string[]; want: number }): Promise<number[]> {
    return new Promise<number[]>((settle, fail) => {
      const timer = setTimeout(
        () => {
          this.#give(worker);
          settle([]);
        },
        Math.max(this.#left, 0),
      );
      const done = (answer: number[]): void => {
        clearTimeout(timer);
        worker.off("message", done);
        worker.off("error", failed);
        settle(answer);
      };
      const failed = (cause: Error): void => {
        clearTimeout(timer);
        fail(cause);
      };
      worker.on("message", done);
      worker.once("error", failed);
      worker.postMessage(ask);
    });
  }

  /** End the thread, which is how a match in progress is stopped. What it was
   * matching is undecided from here on, and every later ask is answered the
   * same way without starting another. */
  #give(worker: Worker): void {
    this.#spent = true;
    this.#worker = undefined;
    void worker.terminate();
  }

  close(): void {
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker !== undefined) void worker.terminate();
  }
}

function compile(args: SessionSearchArgs): Query {
  const query = args.query?.trim();
  if (query === undefined || query === "") return EVERYTHING;
  const sensitive = args.case_sensitive === true;
  const clauses = query
    .split("\n")
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");
  for (const clause of clauses) {
    if (clause.length > MAX_CLAUSE_CHARS) {
      throw new OpError(
        "invalid_args",
        `a query clause may be at most ${MAX_CLAUSE_CHARS} characters, and this one is ${clause.length}`,
      );
    }
  }
  if (clauses.length === 0) return EVERYTHING;
  if (args.regex === true) {
    return new Patterns(
      clauses.map((clause) => {
        try {
          return new RegExp(clause, sensitive ? "" : "i");
        } catch (cause) {
          throw new OpError(
            "invalid_args",
            `${clause} is not a regular expression: ${String(cause)}`,
          );
        }
      }),
    );
  }
  return new Terms(
    clauses.map((clause) => {
      const terms = clause.split(/\s+/).map((term) => (sensitive ? term : term.toLowerCase()));
      return (text: string) => {
        const against = sensitive ? text : text.toLowerCase();
        return terms.every((term) => against.includes(term));
      };
    }),
  );
}

/** Read one transcript, and state it as a hit when it matched.
 *
 * The pass is one: the records that carry the query also carry the working
 * directory, the title and what the session last ran as, so a hit is built
 * from the reading that decided it rather than from a second one. */
async function read(
  candidate: TranscriptFile,
  query: Query,
  wanted: { user: boolean; agent: boolean },
  deps: SearchDeps,
): Promise<SessionSearchHit | undefined> {
  let text: string;
  try {
    text = await readFile(candidate.file, "utf8");
  } catch {
    // Gone since it was listed, which is a session that ended mid-search.
    return undefined;
  }
  /** What could be a match, in the order it was said. Gathered first and
   * matched in one go, because what decides a match may be another thread. */
  const said: SessionSearchMatch[] = [];
  let cwd: string | undefined;
  let title: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let createdAt: number | undefined;
  let read = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    read += 1;
    // The file arrived in one `await` and reading it is CPU from here on, so
    // the pass hands the loop back as it goes rather than at the file's end.
    if (due(read)) await breathe();
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
    const text = record.text;
    if (text === undefined || record.said_by === undefined || !wanted[record.said_by]) continue;
    said.push({
      role: record.said_by,
      text,
      ...(record.said_at === undefined ? {} : { said_at: record.said_at }),
    });
  }
  const found = await query.matching(
    said.map((one) => one.text),
    MATCHES_PER_HIT,
  );
  if (query.stated && found.length === 0) return undefined;
  const matches = found.map((at) => {
    const one = said[at] as SessionSearchMatch;
    return one.text.length > MATCH_CHARS
      ? { ...one, text: `${one.text.slice(0, MATCH_CHARS)}…` }
      : one;
  });
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

/** Whether the project directory could be the working directory asked for.
 *
 * A harness that files by working directory flattens it into one name, and the
 * flattening is lossy — separators, dots and underscores all become dashes — so this only
 * narrows what is opened. What decides a hit is the transcript's own `cwd`. */
function looksLike(project: string | undefined, words: readonly string[]): boolean {
  if (words.length === 0 || project === undefined) return true;
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
