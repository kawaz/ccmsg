import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { InstanceId } from "@ccmsg/protocol";

/** Where the instance accepts WebSocket connections, and from whom.
 *
 * The two allowlists are the entry check of §3.1: what transport asks before a
 * request is upgraded. They are config-driven because who may reach an
 * instance is a deployment fact, not a property of the code. */
export interface EntryConfig {
  readonly host: string;
  /** 0 asks the kernel for a free port. */
  readonly port: number;
  /** Source addresses allowed to connect. Empty means every address the bind
   * itself already permits, which for the default loopback bind is this host. */
  readonly source_ips: readonly string[];
  /** `Origin` values a browser connection may present. Empty means any. */
  readonly origins: readonly string[];
}

/** One value a launch recipe's command reads, as the operator declares it. */
export interface LauncherParamConfig {
  /** A shell identifier: the launcher defines a variable of this name, so a
   * name the shell could not carry is a config the launcher cannot honour. */
  readonly name: string;
  readonly default: string;
}

/** One launch recipe. The shell is the instance's business and is not reported
 * to a client, which is why the contract's template carries no such field. */
export interface LauncherTemplateConfig {
  readonly name: string;
  readonly command: string;
  readonly params: readonly LauncherParamConfig[];
  readonly shell: "bash" | "zsh";
}

/** What the launcher may start, and where.
 *
 * Structured rather than a string because it is a form: the roots bound where a
 * session may run, and the recipes are what `launcher_config_read` answers
 * with. Present is what gives this instance the `launcher` capability. */
export interface LauncherConfig {
  /** Absolute directories a session may be started in. A launch or a walk
   * elsewhere reaches nothing. */
  readonly root_dirs: readonly string[];
  /** In configured order; the first is the default recipe. */
  readonly templates: readonly LauncherTemplateConfig[];
  /** How deep `dir_tree` walks when a request names no depth. */
  readonly depth: number;
  /** How long a launch may run before it is stopped. */
  readonly timeout_secs: number;
  /** Environment names the launched shell does not inherit, as patterns where
   * `*` stands for any run of characters. What a session must not inherit is a
   * deployment fact: an instance's own config home reaching the session it
   * starts would point that session back at this instance's settings. */
  readonly clean_env: readonly string[];
  /** Names kept despite matching `clean_env`, which is what lets one broad
   * pattern be written beside the few exceptions to it. */
  readonly keep_env: readonly string[];
}

/** The upstreams an instance reaches, and the ones it only writes down.
 *
 * The two gateway fields are read: the address is where its service report,
 * quota and spend are asked for, and the source is the path segment it posts
 * what it saw to. The rest are stated as a type so a config carrying them is
 * accepted rather than rejected as unknown, and so what is missing is missing
 * in one visible place. */
export interface UpstreamConfig {
  readonly gateway_url?: string;
  readonly gateway_webhook_source?: string;
  /** Where the secret the gateway presents is kept. Absent uses the path the
   * gateway itself defaults to, which is the one it wrote. */
  readonly gateway_webhook_token_file?: string;
  readonly terminal_gateway?: string;
  readonly launcher?: LauncherConfig;
  /** The program that translates a batch on this host, as an absolute path. It
   * is an upstream like any other: this instance speaks to it and does not
   * build it. */
  readonly translate_helper?: string;
  readonly sandbox_origin?: string;
}

export interface InstanceConfig {
  /** Mesh endpoints to dial (§7.2). The same list goes to every instance, so
   * it never names the instance reading it (§7.1). */
  readonly peers: readonly InstanceId[];
  /** Absent when this instance serves the unix socket only. */
  readonly entry?: EntryConfig;
  readonly upstream: UpstreamConfig;
  /** Whether delivery tries the harness's messaging socket before the `inbox`
   * topic (§4.1 condition 0). On, because the protocol has been read off a
   * running harness; off is for a harness generation that turns out to speak
   * something else, and costs only the reach route (b) never had. */
  readonly direct_delivery: boolean;
  /** Whether this instance answers where a forked session's copy of its
   * ancestor ends. Off, because the answer is found by reading whole sibling
   * transcripts and it decorates a divider: a host that wants it says so, and
   * one that does not never pays for it. The `fork` capability follows this,
   * so a client learns which it is from `hello`. */
  readonly fork_origin: boolean;
}

/** A config file that could not be understood.
 *
 * Its own class so startup can tell "the operator wrote something wrong" from
 * any other failure, and refuse to run rather than continuing with the feature
 * that setting was for silently off (§8.3, DV-Q9). */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    msg: string,
  ) {
    super(`${file}: ${msg}`);
    this.name = "ConfigError";
  }
}

/** An instance with no config file: the unix socket, no peers, no upstreams.
 *
 * Absent is not broken. A config that is not there states nothing wrong, while
 * one that is there and unreadable states something wrong — only the second is
 * the fail-fast case. */
export const DEFAULT_CONFIG: InstanceConfig = {
  peers: [],
  upstream: {},
  direct_delivery: true,
  fork_origin: false,
};

/** Read the config, once, at startup (DV-Q8).
 *
 * There is no watch and no reload: the file is small, an instance is cheap to
 * restart because almost nothing it holds is persistent (§3.6), and restarting
 * is therefore the whole of "apply a config change" (§8.2). */
export function loadConfig(file: string): InstanceConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(file, `not valid JSON (${String(cause)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(file, "the top level must be a JSON object");
  }
  const fields = parsed as Record<string, unknown>;
  return {
    peers: peersOf(file, fields["peers"]),
    ...(fields["entry"] === undefined ? {} : { entry: entryOf(file, fields["entry"]) }),
    upstream: upstreamOf(file, fields["upstream"]),
    direct_delivery: flagOf(
      file,
      "direct_delivery",
      fields["direct_delivery"],
      DEFAULT_CONFIG.direct_delivery,
    ),
    fork_origin: flagOf(file, "fork_origin", fields["fork_origin"], DEFAULT_CONFIG.fork_origin),
  };
}

function flagOf(file: string, at: string, raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") throw new ConfigError(file, `${at} must be true or false`);
  return raw;
}

const INSTANCE_ID = /^wss?:\/\/[^\s?#]+$/;

function peersOf(file: string, raw: unknown): readonly InstanceId[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError(file, "peers must be an array of endpoint URLs");
  return raw.map((peer) => {
    if (typeof peer !== "string" || !INSTANCE_ID.test(peer)) {
      throw new ConfigError(file, `peers must be ws:// or wss:// URLs, got ${String(peer)}`);
    }
    return peer;
  });
}

function entryOf(file: string, raw: unknown): EntryConfig {
  const fields = objectOf(file, "entry", raw);
  const port = fields["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(file, "entry.port must be a port number, or 0 to be assigned one");
  }
  const host = fields["host"] ?? "127.0.0.1";
  if (typeof host !== "string" || host === "") {
    throw new ConfigError(file, "entry.host must be an address to bind");
  }
  return {
    host,
    port,
    source_ips: stringsOf(file, "entry.source_ips", fields["source_ips"]),
    origins: stringsOf(file, "entry.origins", fields["origins"]),
  };
}

function upstreamOf(file: string, raw: unknown): UpstreamConfig {
  if (raw === undefined) return {};
  const fields = objectOf(file, "upstream", raw);
  const config: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    // The launcher is the one upstream that is a form rather than an address,
    // so it is the one read at its own shape; everything else is a string.
    if (name === "launcher") continue;
    if (typeof value !== "string") {
      throw new ConfigError(file, `upstream.${name} must be a string`);
    }
    config[name] = value;
  }
  const launcher = fields["launcher"];
  return {
    ...(config as UpstreamConfig),
    ...(launcher === undefined ? {} : { launcher: launcherOf(file, launcher) }),
  };
}

/** How deep `dir_tree` walks, and how long a launch may take, when the config
 * says neither. */
const DEFAULT_DEPTH = 2;
const DEFAULT_TIMEOUT_SECS = 10;

/** A shell identifier, which is what a launch parameter's name has to be: the
 * launcher defines a variable of that name for the command to read. */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function launcherOf(file: string, raw: unknown): LauncherConfig {
  const fields = objectOf(file, "upstream.launcher", raw);
  const roots = stringsOf(file, "upstream.launcher.root_dirs", fields["root_dirs"]);
  if (roots.length === 0 || roots.some((root) => !isAbsolute(root))) {
    throw new ConfigError(
      file,
      "upstream.launcher.root_dirs must name at least one absolute directory",
    );
  }
  const templates = templatesOf(file, fields["templates"]);
  if (templates.length === 0) {
    throw new ConfigError(file, "upstream.launcher.templates must hold at least one recipe");
  }
  return {
    root_dirs: roots,
    templates,
    depth: countOf(file, "upstream.launcher.depth", fields["depth"], DEFAULT_DEPTH),
    timeout_secs: countOf(
      file,
      "upstream.launcher.timeout_secs",
      fields["timeout_secs"],
      DEFAULT_TIMEOUT_SECS,
    ),
    clean_env: stringsOf(file, "upstream.launcher.clean_env", fields["clean_env"]),
    keep_env: stringsOf(file, "upstream.launcher.keep_env", fields["keep_env"]),
  };
}

function templatesOf(file: string, raw: unknown): LauncherTemplateConfig[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError(file, "upstream.launcher.templates must be an array of recipes");
  }
  const names = new Set<string>();
  return raw.map((entry, index) => {
    const at = `upstream.launcher.templates[${index}]`;
    const fields = objectOf(file, at, entry);
    const name = fields["name"];
    const command = fields["command"];
    if (typeof name !== "string" || name === "") {
      throw new ConfigError(file, `${at}.name must be a name for the recipe`);
    }
    if (names.has(name)) throw new ConfigError(file, `${at}.name repeats ${name}`);
    names.add(name);
    if (typeof command !== "string" || command === "") {
      throw new ConfigError(file, `${at}.command must be a shell program`);
    }
    const shell = fields["shell"] ?? "bash";
    if (shell !== "bash" && shell !== "zsh") {
      throw new ConfigError(file, `${at}.shell must be bash or zsh`);
    }
    return { name, command, shell, params: paramsOf(file, at, fields["params"]) };
  });
}

function paramsOf(file: string, at: string, raw: unknown): LauncherParamConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError(file, `${at}.params must be an array of parameters`);
  }
  return raw.map((entry, index) => {
    const where = `${at}.params[${index}]`;
    const fields = objectOf(file, where, entry);
    const name = fields["name"];
    const fallback = fields["default"] ?? "";
    if (typeof name !== "string" || !SHELL_NAME.test(name)) {
      throw new ConfigError(file, `${where}.name must be a shell identifier`);
    }
    if (typeof fallback !== "string") {
      throw new ConfigError(file, `${where}.default must be a string`);
    }
    return { name, default: fallback };
  });
}

function countOf(file: string, at: string, raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new ConfigError(file, `${at} must be a positive whole number`);
  }
  return raw;
}

function objectOf(file: string, at: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(file, `${at} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function stringsOf(file: string, at: string, raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new ConfigError(file, `${at} must be an array of strings`);
  }
  return raw as string[];
}
