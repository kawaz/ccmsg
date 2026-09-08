import type {
  Capability,
  DirTreeArgs,
  DirTreeResult,
  LauncherConfigReadResult,
  LauncherRunArgs,
  LauncherRunResult,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../dispatch/index.ts";
import type { LauncherConfig, LauncherTemplateConfig } from "../instance/config.ts";
import { spawnLaunch } from "./spawn.ts";
import { insideRoots } from "./roots.ts";
import { dirTree } from "./tree.ts";

/** The capability the three launcher ops need. A launcher with no roots and no
 * recipes has no form to answer with, so a client is told there is none rather
 * than being handed an empty one. */
export function launcherCapabilities(config?: LauncherConfig): Capability[] {
  return config === undefined ? [] : ["launcher"];
}

/** One launch, as everything but the spawning sees it. */
export interface Launch {
  /** The shell and its program, ready to run. */
  readonly argv: readonly string[];
  /** The checked directory, which is both where the command runs and what it
   * sees as its working directory. */
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly timeoutMs: number;
}

/** Whoever starts the command. The one part of a launch that touches the host,
 * kept behind a name so a test can watch a launch being assembled without a
 * process being started. */
export type LaunchRunner = (launch: Launch) => Promise<LauncherRunResult>;

export interface LauncherDeps {
  /** The environment a launched command starts from, before `clean_env`. */
  readonly env?: Record<string, string | undefined>;
  readonly run?: LaunchRunner;
}

/** What the launcher may start, and the two ops that read and use it.
 *
 * No value a caller sends is ever spliced into shell text: the parameters reach
 * the command as shell variables, and the directory is the one the containment
 * check resolved rather than the one the caller wrote. */
export class Launcher {
  readonly #env: Record<string, string | undefined>;
  readonly #run: LaunchRunner;

  constructor(
    private readonly config: LauncherConfig,
    deps: LauncherDeps = {},
  ) {
    this.#env = deps.env ?? process.env;
    this.#run = deps.run ?? spawnLaunch;
  }

  /** The form: where a session may run, and the recipes it may run under. How
   * the shell runs one is not reported, because nothing a client does with the
   * answer depends on it. */
  configRead(): LauncherConfigReadResult {
    return {
      root_dirs: [...this.config.root_dirs],
      templates: this.config.templates.map((template) => ({
        name: template.name,
        command: template.command,
        params: template.params.map((param) => ({ name: param.name, default: param.default })),
      })),
    };
  }

  tree(args: DirTreeArgs): DirTreeResult {
    return dirTree(this.config, args);
  }

  run(args: LauncherRunArgs): Promise<LauncherRunResult> {
    const cwd = insideRoots(this.config, args.cwd);
    if (cwd === undefined) {
      // The op states no refusal for a path, so a directory outside the roots
      // is answered as what it is from here: an argument this launcher cannot
      // act on.
      throw new OpError("invalid_args", `${args.cwd} is not a directory the launcher may start in`);
    }
    const template = this.template(args.template);
    const declared = new Map(template.params.map((param) => [param.name, param.default]));
    for (const name of Object.keys(args.params)) {
      if (!declared.has(name)) {
        throw new OpError(
          "invalid_args",
          `${template.name} declares no parameter called ${name}, so nothing would read it`,
        );
      }
    }
    const values: Record<string, string> = {};
    for (const [name, fallback] of declared) {
      values[carrier(name)] = args.params[name] ?? fallback;
    }
    return this.#run({
      argv: shellArgv(
        template.shell,
        program([...declared.keys()], args.command ?? template.command),
      ),
      cwd,
      env: { ...cleaned(this.#env, this.config), ...values },
      timeoutMs: this.config.timeout_secs * 1000,
    });
  }

  /** The recipe a launch names, or the default one. An unknown name is refused
   * rather than replaced with another, because running a different recipe than
   * the one asked for is worse than running none. */
  private template(name?: string): LauncherTemplateConfig {
    if (name === undefined) {
      const first = this.config.templates[0];
      if (first === undefined) throw new OpError("invalid_args", "this launcher has no recipe");
      return first;
    }
    const found = this.config.templates.find((template) => template.name === name);
    if (found === undefined) throw new OpError("invalid_args", `no recipe is called ${name}`);
    return found;
  }
}

export function launcherHandlers(launcher: Launcher) {
  return {
    launcher_config_read: (): LauncherConfigReadResult => launcher.configRead(),
    launcher_run: (input: HandlerInput): Promise<LauncherRunResult> =>
      launcher.run(input.args as unknown as LauncherRunArgs),
    dir_tree: (input: HandlerInput): DirTreeResult =>
      launcher.tree(input.args as unknown as DirTreeArgs),
  };
}

/** The environment variable one parameter's value travels in.
 *
 * A carrier of its own, in a namespace the shell erases before the command
 * runs, so the value reaches the command as a plain shell variable and nothing
 * the command starts inherits it. */
export function carrier(name: string): string {
  return `ccmsg_launch_param_${name}`;
}

/** The shell program: the prologue that moves every parameter out of the
 * environment, then the recipe's command.
 *
 * Both run in one shell. A nested `sh -c` would defeat the whole arrangement,
 * since a variable that is not exported does not cross into a child. Every
 * declared parameter is defined, empty rather than absent when nothing supplied
 * one, so a command run under `set -u` does not abort on a field left blank. */
export function program(names: readonly string[], command: string): string {
  const prologue = names
    .map((name) => `unset -v ${name}; ${name}="$${carrier(name)}"; unset -v ${carrier(name)}`)
    .join("\n");
  // A newline rather than `;` so a command opening with a comment or a shell
  // keyword parses exactly as it was written.
  return `${prologue}\n${command}`;
}

export function shellArgv(shell: "bash" | "zsh", command: string): string[] {
  return shell === "bash"
    ? ["bash", "-eu", "-o", "pipefail", "-c", command]
    : ["zsh", "-e", "-u", "-o", "pipefail", "-c", command];
}

/** The environment a launched command starts from: this instance's own, minus
 * what `clean_env` names and back again for what `keep_env` does. Keep wins, so
 * one broad pattern can be written beside its exceptions. */
function cleaned(
  env: Record<string, string | undefined>,
  config: LauncherConfig,
): Record<string, string | undefined> {
  const clean = config.clean_env.map(pattern);
  const keep = config.keep_env.map(pattern);
  const kept: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (clean.some((each) => each.test(name)) && !keep.some((each) => each.test(name))) continue;
    kept[name] = value;
  }
  return kept;
}

/** One `clean_env` pattern, where `*` stands for any run of characters and
 * everything else is literal. */
function pattern(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`);
}
