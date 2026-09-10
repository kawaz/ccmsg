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
}

export const HARNESS: Record<Harness, HarnessFacts> = {
  claude: { marker: "settings.json", transcripts: "projects", homeEnv: "CLAUDE_CONFIG_DIR" },
  codex: { marker: "config.toml", transcripts: "sessions", homeEnv: "CODEX_HOME" },
};

export function isHarness(value: unknown): value is Harness {
  return HARNESSES.includes(value as Harness);
}
