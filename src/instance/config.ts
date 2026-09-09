import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Endpoint } from "@ccmsg/protocol";

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
  /** `Origin` values a browser connection may present. Empty admits no
   * browser at all: a request carrying no `Origin` is not a browser's and is
   * judged on the address and the token alone, so the list only ever widens
   * what reaches the socket, and an unlisted webui is refused rather than
   * let in by default. */
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
  /** Where other instances reach this one (§7.1). Stated rather than
   * discovered: an instance may be reached through a proxy or an alias, so the
   * URL a peer is to dial is not a thing the process can read off its own
   * socket. Required of an instance that has a mesh.
   *
   * Its `ws(s)://` form is what the mesh handshake compares as `aud`; the
   * `http(s)://` URL with the same host and path is where the mesh's own
   * routes hang. */
  readonly self?: Endpoint;
  /** Mesh endpoints to dial (§7.2). The same list goes to every instance, and
   * it may name this one: an instance takes itself out of the list it dials,
   * so one file can be copied to every host unchanged (§8.2). */
  readonly peers: readonly Endpoint[];
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
export function loadConfig(file: string, dir: string): InstanceConfig {
  return parseConfig(file, settingsFor(loadShared(file), dir));
}

/** One config home the shared file knows about.
 *
 * `dir` is the config home itself, which is what an instance is (A2); the rest
 * is whatever that instance sets differently from `defaults`, held raw because
 * it is merged before it is read. */
export interface InstanceEntry {
  readonly dir: string;
  readonly settings: Record<string, unknown>;
}

/** The one file a person edits: what every instance gets, and which config
 * homes run one.
 *
 * One file rather than one per config home because both of the things it
 * carries are facts about the set — the peer list is the same for every
 * instance (§7.1), and "which config homes run an instance" is a question no
 * single instance can answer about itself. */
export interface SharedConfig {
  readonly defaults: Record<string, unknown>;
  readonly instances: readonly InstanceEntry[];
}

export const EMPTY_SHARED: SharedConfig = { defaults: {}, instances: [] };

/** Read the shared file. Absent is not broken, for `DEFAULT_CONFIG`'s reason,
 * so it reads as the empty one; present and wrong ends the read (DV-Q9). */
export function loadShared(file: string): SharedConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return EMPTY_SHARED;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(file, `not valid JSON (${String(cause)})`);
  }
  const top = objectOf(file, "the top level", parsed);
  for (const name of Object.keys(top)) {
    if (name !== "defaults" && name !== "instances") {
      throw new ConfigError(file, `unknown top-level key ${name}; expected defaults or instances`);
    }
  }
  const raw = top["instances"];
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new ConfigError(file, "instances must be an array of config homes");
  }
  const seen = new Set<string>();
  const instances = ((raw ?? []) as unknown[]).map((entry, index) => {
    const fields = objectOf(file, `instances[${index}]`, entry);
    const { dir, ...settings } = fields;
    if (typeof dir !== "string" || !isAbsolute(dir)) {
      throw new ConfigError(file, `instances[${index}].dir must be an absolute config home`);
    }
    if (seen.has(dir)) throw new ConfigError(file, `instances[${index}].dir repeats ${dir}`);
    seen.add(dir);
    return { dir, settings };
  });
  return {
    defaults: top["defaults"] === undefined ? {} : objectOf(file, "defaults", top["defaults"]),
    instances,
  };
}

/** Write the shared file back, at the shape a person reads it in. */
export function saveShared(file: string, shared: SharedConfig): void {
  const instances = shared.instances.map((entry) => ({ dir: entry.dir, ...entry.settings }));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ defaults: shared.defaults, instances }, null, 2)}\n`);
}

/** What one config home's instance is configured with: its own entry over the
 * shared defaults, key by key. A config home the file does not list still
 * resolves — `daemon run` on an unregistered directory is the defaults plus
 * the built-ins. */
export function settingsFor(shared: SharedConfig, dir: string): Record<string, unknown> {
  const entry = shared.instances.find((one) => one.dir === dir);
  return { ...shared.defaults, ...entry?.settings };
}

/** One instance's settings, read at the shape the instance uses them. */
export function parseConfig(file: string, fields: Record<string, unknown>): InstanceConfig {
  const config = {
    ...(fields["self"] === undefined ? {} : { self: endpointOf(file, "self", fields["self"]) }),
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
  // A mesh instance is dialled by its peers, and where they dial it is the one
  // thing it cannot work out for itself. Refused here rather than at the first
  // handshake, for the reason any broken setting is (DV-Q9).
  if (config.self === undefined && config.peers.length > 0 && config.entry !== undefined) {
    throw new ConfigError(file, "self must name this instance's endpoint URL when peers are set");
  }
  return config;
}

function flagOf(file: string, at: string, raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") throw new ConfigError(file, `${at} must be true or false`);
  return raw;
}

const ENDPOINT = /^wss?:\/\/[^\s?#]+$/;

function endpointOf(file: string, at: string, raw: unknown): Endpoint {
  if (typeof raw !== "string" || !ENDPOINT.test(raw)) {
    throw new ConfigError(file, `${at} must be a ws:// or wss:// URL, got ${String(raw)}`);
  }
  return raw;
}

function peersOf(file: string, raw: unknown): readonly Endpoint[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError(file, "peers must be an array of endpoint URLs");
  return raw.map((peer, index) => endpointOf(file, `peers[${index}]`, peer));
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
