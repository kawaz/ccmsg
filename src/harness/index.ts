/** Which harness a config home runs, and the few facts that differ with it.
 *
 * A harness is an attribute of an instance rather than of the contract: an
 * instance answers for one config home (M6), that config home belongs to one
 * program, and every difference below is a place where that program keeps
 * something ccmsg reads. The protocol never names a harness, so nothing a
 * client sees changes with this — what changes is which directory is walked,
 * what says a session is there, and how route (a) is spoken.
 *
 * The facts live together because they are one table: adding a harness is
 * filling a row, and a difference that has no row here is a difference nobody
 * declared. */

export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

/** What a config home runs when nothing says otherwise. Claude Code, because
 * it is the harness ccmsg was read off and the one an unmarked config home in
 * an existing setup belongs to. */
export const DEFAULT_HARNESS: Harness = "claude";

export interface HarnessFacts {
  /** The file whose presence says a directory is this harness's config home
   * rather than any directory somebody typed. Both harnesses keep their own
   * settings in one, so this is the harness's own word for "mine". */
  readonly marker: string;
  /** The directory under the config home where transcripts are kept. Claude
   * Code files them per working directory, Codex per date, so what this names
   * is the root of the tree and not the directory a file is in. */
  readonly transcripts: string;
  /** The environment variable that names this harness's config home, which is
   * what a session's own processes are run with. */
  readonly homeEnv: string;
  /** The variables that name the session a process is running inside, in the
   * order they are believed. Set by the harness for the commands its session
   * runs, and by nothing else — which is what makes them the answer to "whose
   * session is this". */
  readonly sessionEnv: readonly string[];
}

export const HARNESS: Record<Harness, HarnessFacts> = {
  claude: {
    marker: "settings.json",
    transcripts: "projects",
    homeEnv: "CLAUDE_CONFIG_DIR",
    sessionEnv: ["CLAUDE_CODE_SESSION_ID"],
  },
  codex: {
    marker: "config.toml",
    transcripts: "sessions",
    homeEnv: "CODEX_HOME",
    sessionEnv: ["CODEX_THREAD_ID", "CODEX_SESSION_ID"],
  },
};

/** The session a process is running inside, where its environment says so.
 *
 * Which harness is asked first cannot be the order two config-home variables
 * happen to be listed in: a session of one harness started from a session of
 * the other inherits the whole environment of its parent, so both homes are
 * named at once and the outer one is named first. Measured, and not a corner:
 * a Codex session started from a Claude Code session inherits
 * `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_SESSION_ID` and the rest of it.
 *
 * So what decides is the session variables, and the config home follows from
 * whichever harness claimed the process — one answer used both for "who am I"
 * and for "which instance do I speak to", so the two can never disagree.
 *
 * Where more than one claims it, the order below decides, and it is not the
 * order the harnesses are listed in. Claude Code exports its session id into
 * everything the session starts, another harness included; Codex names its
 * thread to the commands of its own turn. The narrower claim is the truer one,
 * so it is asked first. The reverse nesting — a Claude Code session started
 * from inside a Codex turn — reads as Codex. `--sid` overrides only the sid a
 * command speaks as, and not which instance it speaks to (§3.8).
 *
 * A process no session runs inside — a person at a terminal, a supervisor —
 * matches nothing here, and the caller falls back to what it would have done
 * before being asked. */
const CLAIM_ORDER: readonly Harness[] = ["codex", "claude"];

export function currentSession(
  env: Record<string, string | undefined>,
): { harness: Harness; sid: string } | undefined {
  for (const harness of CLAIM_ORDER) {
    for (const variable of HARNESS[harness].sessionEnv) {
      const sid = env[variable];
      if (sid !== undefined && sid !== "") return { harness, sid };
    }
  }
  return undefined;
}

export function isHarness(value: unknown): value is Harness {
  return HARNESSES.includes(value as Harness);
}
