import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { type DumpPreset, type Endpoint, TranscriptItemSelector } from "@ccmsg/protocol";
import { DEFAULT_HARNESS, type Harness, HARNESSES, isHarness } from "../harness/index.ts";
import { ID } from "./identity.ts";
import { parseCidr } from "./client.ts";

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
  /** Address blocks, in CIDR notation, whose `X-Forwarded-For` this instance
   * believes.
   *
   * Separate from `source_ips` because the two answer different questions: that
   * one is who may connect at all, this one is whose account of somebody else
   * to take. A reverse proxy is commonly allowed in without being the only
   * thing allowed in, and an operator with no proxy leaves this empty and has
   * every forwarding header ignored. */
  readonly trusted_proxies: readonly string[];
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
 * session may run, and the recipes are what `launcher.config.read` answers
 * with. Present is what gives this instance the `launcher` capability. */
export interface LauncherConfig {
  /** Absolute directories a session may be started in. A launch or a walk
   * elsewhere reaches nothing. */
  readonly root_dirs: readonly string[];
  /** In configured order; the first is the default recipe. */
  readonly templates: readonly LauncherTemplateConfig[];
  /** How deep `dir.tree` walks when a request names no depth. */
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

/** The named selections a person dumps by.
 *
 * Configured rather than fixed in the contract because what a preset names is
 * an interest — how the work was done, what to hand over — and an interest is
 * not a property of the wire. A type name stays one to one with what a record
 * is, and the groupings people reach for are made by naming a set of them. */
export interface DumpConfig {
  /** In configured order, which is the order `dump.presets.read` answers in. */
  readonly presets: readonly DumpPreset[];
}

export interface InstanceConfig {
  /** Which harness this config home runs (§3.8).
   *
   * A setting rather than something discovered, because it decides where the
   * instance looks before there is anything there to look at: an empty config
   * home says nothing about the program it belongs to, and an instance that
   * guessed would walk the wrong tree for the whole of its first session. */
  readonly harness: Harness;
  /** Every mesh endpoint, this instance's own among them (§7.1).
   *
   * Derived rather than written: the instances on this host are the ones whose
   * files say which port they listen on, and the rest are the endpoints
   * `peers.json` names. A person who had to write the local half as well would
   * be writing down a second time what `daemon add` already settled, and could
   * get it wrong — which is a mesh an instance is silently not in. Which entry
   * of the list is this instance is settled at startup by the probe (§7.1). */
  readonly peers: readonly Endpoint[];
  /** Where peers and people reach this instance, when that is not the address
   * it binds.
   *
   * An instance behind a reverse proxy is dialled at the proxy's name and
   * listens on loopback, and the two cannot be derived from each other. It is
   * what the mesh puts in its list for this instance — so it is what the probe
   * settles `self` to, what a handshake carries as `iss` and `aud`, and what
   * a person is handed to open a page at (§7.1). Absent leaves the address
   * this instance binds, which is what a host with no proxy in front of it
   * has.
   *
   * Stated per instance, in the file that already states which port: what a
   * proxy is set up to forward where is one fact, and writing it twice is a
   * second place for it to be wrong. */
  readonly endpoint?: Endpoint;
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
  readonly dump: DumpConfig;
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
  harness: DEFAULT_HARNESS,
  peers: [],
  upstream: {},
  direct_delivery: true,
  fork_origin: false,
  dump: { presets: [] },
};

/** The file every instance's settings start from, and the directory holding
 * one file per instance. Both are read from the config home a person edits
 * (§8.2). */
export const CONFIG_FILE = "config.ts";
export const INSTANCES_DIR = "instances";

/** The declarations a config file writes against, as they are called where
 * they are copied to. */
export const TYPES_FILE = "ccmsg-config.d.ts";

/** What the settings used to be written in. Named so a config home that still
 * holds one is told where its settings have moved to, rather than starting
 * with every setting it carried silently absent. */
const JSON_FILE = "config.json";

/** The fields a config function may hand back. Checked rather than ignored,
 * because a misspelled field is a setting that was written and does not take:
 * the types say so while the file is being edited, and this says so when it is
 * read. */
const FIELDS = ["harness", "entry", "upstream", "direct_delivery", "fork_origin", "dump"] as const;

/** What only one instance's own file may state: which config home it answers
 * for, and the address it is reached at. Neither is a thing the shared file
 * could say once for everybody. */
const INSTANCE_FIELDS = ["dir", "name", "endpoint"] as const;

/** Which clusters this host knows of, and where each one's own file is.
 *
 * Data rather than a function, and a list rather than a directory listing: what
 * is a cluster and what is an instance is stated, so a file nobody listed is
 * not read and a file somebody listed and then deleted is an error rather than
 * a cluster that quietly shrank. `ccmsg mesh` and `daemon add` write these,
 * which is why they are the shape a program reads whole.
 *
 * A cluster's file is this host's account of that cluster. A cluster spans
 * hosts and no copy of it is the canonical one: each host writes down the peers
 * it dials and the instances it runs. */
export const CLUSTERS_FILE = "clusters.json";
export const CLUSTERS_DIR = "clusters";

export function clusterFileName(id: string): string {
  return `cluster-${id}.json`;
}

export function instanceFileName(id: string): string {
  return `instance-${id}.ts`;
}

/** What one file under `instances/` says: which config home it is for, and
 * what that instance runs with.
 *
 * The id is what the file is called and what everything the instance issued is
 * keyed by; the name is a label a person picks and may change, and defaults to
 * the id. Keeping them apart is what lets a rename be a rename — the file, the
 * state directory and every record already written stay where they are. */
export interface InstanceSetting {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly config: InstanceConfig;
  /** The clusters this instance belongs to, in the order the host lists them.
   * More than one is allowed: an instance is a config home, and which
   * management units it is part of is a separate question (A2). */
  readonly clusters: readonly ClusterInfo[];
}

/** One cluster, as this host writes it down.
 *
 * A cluster is the unit a person manages: some instances, one mesh, one scope
 * for the authentication records that are replicated across it. Which
 * instances are in it is stated here rather than discovered, so an instance
 * file that nobody listed runs nothing and an id listed with no file is an
 * error. */
export interface ClusterSetting {
  readonly id: string;
  readonly name: string;
  /** The mesh endpoints of this cluster that this host does not serve itself.
   * The ones it does serve are the instances listed below, at the address each
   * of their files gives them. */
  readonly peers: readonly Endpoint[];
  readonly instances: readonly string[];
}

/** What an instance is told about one cluster it belongs to: which cluster,
 * and every mesh endpoint of it — this instance's own among them, because that
 * is what the startup probe settles which entry it is against (§7.1). */
export interface ClusterInfo {
  readonly id: string;
  readonly name: string;
  readonly peers: readonly Endpoint[];
}

/** A label a person may give an instance or a cluster.
 *
 * Narrow because it is typed at a command and printed in a listing, not
 * because anything is found by it: files are named by id, so a name may change
 * without moving anything. */
export const CONFIG_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Everything the config home says, read once (DV-Q8).
 *
 * There is no watch and no reload: the files are small, an instance is cheap
 * to restart because almost nothing it holds is persistent (§3.6), and
 * restarting is therefore the whole of "apply a config change" (§8.2).
 *
 * The functions are handed frozen copies of what they build on and a mutable
 * copy of their own starting point, so what an instance runs with is what its
 * file returned: there is no merge rule to know, because the file does the
 * combining itself and can see exactly what it is combining with. */
export async function loadAll(configDir: string): Promise<{
  readonly defaults: InstanceConfig;
  readonly clusters: readonly ClusterSetting[];
  readonly instances: readonly InstanceSetting[];
}> {
  const file = join(configDir, CONFIG_FILE);
  if (!existsSync(file)) {
    const legacy = join(configDir, JSON_FILE);
    if (existsSync(legacy)) {
      throw new ConfigError(
        legacy,
        `settings are TypeScript now: write ${file}, ${join(configDir, CLUSTERS_FILE)} and ${join(configDir, INSTANCES_DIR, instanceFileName("<id>"))}`,
      );
    }
    return { defaults: DEFAULT_CONFIG, clusters: [], instances: [] };
  }
  const returned = await called(file, {
    builtin: frozen(DEFAULT_CONFIG),
    config: copied(DEFAULT_CONFIG),
  });
  const defaults = settingsOf(file, returned, false).config;
  const clusters = loadClusters(configDir);

  // Every instance any cluster lists, read once however many clusters list it:
  // an instance is one config home and one process, and belonging to two
  // clusters is not being two of anything.
  const own = new Map<string, { name: string; dir: string; config: InstanceConfig }>();
  const homes = new Map<string, string>();
  for (const cluster of clusters) {
    for (const id of cluster.instances) {
      if (own.has(id)) continue;
      const at = join(configDir, INSTANCES_DIR, instanceFileName(id));
      if (!existsSync(at)) {
        throw new ConfigError(
          join(configDir, CLUSTERS_DIR, clusterFileName(cluster.id)),
          `names instance ${id}, whose file ${at} is not there`,
        );
      }
      const answer = await called(at, {
        builtin: frozen(DEFAULT_CONFIG),
        default: frozen(defaults),
        config: { ...copied(defaults), dir: "", name: id },
      });
      const settings = settingsOf(at, answer, true);
      // Two instances answering for one config home would take each other's
      // lock and state (A2), so which of the two files is wrong is asked here
      // rather than discovered as a start that never settles.
      const already = homes.get(settings.dir);
      if (already !== undefined) {
        throw new ConfigError(at, `dir ${settings.dir} is already what ${already} answers for`);
      }
      homes.set(settings.dir, instanceFileName(id));
      own.set(id, {
        name: settings.name === "" ? id : settings.name,
        dir: settings.dir,
        config: settings.config,
      });
    }
  }

  // What each cluster's mesh is: its own remote peers, and the instances of
  // this host that are in it, each at the address its file gives it (§7.1).
  const meshes = new Map<string, ClusterInfo>();
  for (const cluster of clusters) {
    const mesh: Endpoint[] = [];
    for (const id of cluster.instances) {
      const reached = endpointOfInstance(own.get(id)?.config);
      if (reached !== undefined && !mesh.includes(reached)) mesh.push(reached);
    }
    for (const peer of cluster.peers) if (!mesh.includes(peer)) mesh.push(peer);
    meshes.set(cluster.id, { id: cluster.id, name: cluster.name, peers: mesh });
  }

  const instances = [...own].map(([id, held]) => {
    const mine = clusters
      .filter((cluster) => cluster.instances.includes(id))
      .flatMap((cluster) => {
        const info = meshes.get(cluster.id);
        return info === undefined ? [] : [info];
      });
    // The mesh this instance dials is every cluster it is in. Holding the
    // clusters apart as well is what the isolation between them will be built
    // on; what it does today is say which are which.
    const peers: Endpoint[] = [];
    for (const cluster of mine) {
      for (const peer of cluster.peers) if (!peers.includes(peer)) peers.push(peer);
    }
    return {
      id,
      name: held.name,
      dir: held.dir,
      config: { ...held.config, peers },
      clusters: mine,
    };
  });
  return { defaults, clusters, instances };
}

/** Where a peer reaches one instance: what its file says it is reached at, and
 * failing that the address it binds. Neither is an instance that serves the
 * unix socket alone, which is in nobody's mesh. */
function endpointOfInstance(config: InstanceConfig | undefined): Endpoint | undefined {
  if (config === undefined) return undefined;
  if (config.endpoint !== undefined) return config.endpoint;
  return config.entry === undefined ? undefined : localEndpoint(config.entry);
}

/** The clusters this host knows of, in the order it lists them. */
export function loadClusters(configDir: string): readonly ClusterSetting[] {
  const file = join(configDir, CLUSTERS_FILE);
  const top = readJson(file);
  if (top === undefined) return [];
  const listed = (top as { clusters?: unknown })["clusters"];
  if (!Array.isArray(listed) || listed.some((id) => !ID.test(String(id)))) {
    throw new ConfigError(file, "clusters must be an array of cluster ids");
  }
  const ids = listed as string[];
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length > 0) {
    throw new ConfigError(file, `repeats ${[...new Set(repeated)].join(", ")}`);
  }
  return ids.map((id) => loadCluster(configDir, id));
}

/** One cluster's own file. Listed and missing is an error: a cluster whose
 * instances could not be read is a mesh silently short of them. */
export function loadCluster(configDir: string, id: string): ClusterSetting {
  const file = join(configDir, CLUSTERS_DIR, clusterFileName(id));
  const fields = readJson(file);
  if (fields === undefined) {
    throw new ConfigError(
      join(configDir, CLUSTERS_FILE),
      `names cluster ${id}, whose file ${file} is not there`,
    );
  }
  const name = fields["name"];
  if (name !== undefined && (typeof name !== "string" || !CONFIG_NAME.test(name))) {
    throw new ConfigError(file, "name must be a label in lower case, digits, dots, dashes");
  }
  const peers = fields["peers"];
  if (peers !== undefined && !Array.isArray(peers)) {
    throw new ConfigError(file, "peers must be an array of endpoint URLs");
  }
  const read = ((peers ?? []) as unknown[]).map((peer, index) =>
    endpointOf(file, `peers[${String(index)}]`, peer),
  );
  const twice = read.filter((peer, index) => read.indexOf(peer) !== index);
  if (twice.length > 0)
    throw new ConfigError(file, `peers repeats ${[...new Set(twice)].join(", ")}`);
  const instances = fields["instances"];
  if (
    instances !== undefined &&
    (!Array.isArray(instances) || instances.some((one) => !ID.test(String(one))))
  ) {
    throw new ConfigError(file, "instances must be an array of instance ids");
  }
  return {
    id,
    name: typeof name === "string" ? name : id,
    peers: read,
    instances: (instances ?? []) as string[],
  };
}

/** Write one cluster's file back, at the shape a person reads it in. */
export function saveCluster(configDir: string, cluster: ClusterSetting): void {
  mkdirSync(join(configDir, CLUSTERS_DIR), { recursive: true });
  writeFileSync(
    join(configDir, CLUSTERS_DIR, clusterFileName(cluster.id)),
    `${JSON.stringify({ name: cluster.name, peers: cluster.peers, instances: cluster.instances }, null, 2)}\n`,
  );
}

/** Write down which clusters there are. */
export function saveClusters(configDir: string, ids: readonly string[]): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, CLUSTERS_FILE), `${JSON.stringify({ clusters: ids }, null, 2)}\n`);
}

function readJson(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(file, `not valid JSON (${String(cause)})`);
  }
  return objectOf(file, "the top level", parsed);
}

/** The address another instance on this host is dialled at, when its file
 * states no public one.
 *
 * A bind of every address is not an address, so a host that listens on all of
 * them is reached at the loopback one — the peer doing the dialling is on this
 * machine, and that is the address it has. */
function localEndpoint(entry: EntryConfig): Endpoint {
  const host = entry.host === "0.0.0.0" || entry.host === "::" ? "127.0.0.1" : entry.host;
  const at = host.includes(":") ? `[${host}]` : host;
  return `http://${at}:${String(entry.port)}/` as Endpoint;
}

/** The instances this host runs, in the order its clusters list them. */
export async function loadInstances(configDir: string): Promise<readonly InstanceSetting[]> {
  return (await loadAll(configDir)).instances;
}

/** What one config home's instance runs with. A config home no cluster lists
 * still resolves — `daemon run` on an unregistered directory is what
 * `config.ts` returns, plus the built-ins. */
export async function loadConfig(configDir: string, dir: string): Promise<InstanceConfig> {
  const all = await loadAll(configDir);
  return all.instances.find((one) => one.dir === dir)?.config ?? all.defaults;
}

/** Put the declarations a config file writes against beside the files that
 * write against them.
 *
 * Copied into the config home rather than reached where this build keeps them:
 * a relative `import type` resolves with no tsconfig and no node_modules
 * anywhere near it, and it goes on resolving when this checkout moves. */
export function writeConfigTypes(configDir: string): string {
  const at = join(configDir, TYPES_FILE);
  mkdirSync(configDir, { recursive: true });
  copyFileSync(new URL(`./${TYPES_FILE}`, import.meta.url).pathname, at);
  return at;
}

/** Import one config file and call what it exports.
 *
 * The modified time rides on the specifier because an import is cached by it:
 * a file read again in the same process after being edited — a supervisor
 * asked to add an instance, a test writing two configs — would otherwise be
 * the first read over again. */
async function called(file: string, ctx: Record<string, unknown>): Promise<unknown> {
  let module: { default?: unknown };
  try {
    module = (await import(`${file}?mtime=${String(statSync(file).mtimeMs)}`)) as {
      default?: unknown;
    };
  } catch (cause) {
    throw new ConfigError(file, `cannot be loaded (${String(cause)})`);
  }
  const define = module.default;
  if (typeof define !== "function") {
    throw new ConfigError(
      file,
      "must default export a function taking { config } and returning it",
    );
  }
  try {
    return await (define as (given: unknown) => unknown)(ctx);
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(file, `threw while being read (${String(cause)})`);
  }
}

/** What one config function handed back, checked at the shape an instance uses
 * it. */
function settingsOf(
  file: string,
  returned: unknown,
  wantsDir: boolean,
): { dir: string; name: string; config: InstanceConfig } {
  const fields = objectOf(file, "what the config function returned", returned);
  for (const name of Object.keys(fields)) {
    if ((INSTANCE_FIELDS as readonly string[]).includes(name)) {
      if (wantsDir) continue;
      throw new ConfigError(
        file,
        `${name} belongs to an ${INSTANCES_DIR}/ file, which this is not`,
      );
    }
    if (name === "peers") {
      // Said as its own refusal rather than as an unknown field, because a
      // person writing one is not misspelling anything: they are stating a
      // mesh, and the answer is where a mesh is stated now.
      throw new ConfigError(
        file,
        `peers are not written here: a mesh belongs to a cluster, so the instances of one are the ids its ${CLUSTERS_DIR}/ file lists and the rest are that file's peers (ccmsg mesh add)`,
      );
    }
    if (!(FIELDS as readonly string[]).includes(name)) {
      throw new ConfigError(file, `unknown field ${name}; expected ${FIELDS.join(", ")}`);
    }
  }
  const dir = fields["dir"];
  if (wantsDir && (typeof dir !== "string" || !isAbsolute(dir))) {
    throw new ConfigError(file, "dir must be the absolute config home this instance answers for");
  }
  const name = fields["name"];
  if (name !== undefined && (typeof name !== "string" || !CONFIG_NAME.test(name))) {
    throw new ConfigError(file, "name must be a label in lower case, digits, dots, dashes");
  }
  return {
    dir: wantsDir ? (dir as string) : "",
    name: typeof name === "string" ? name : "",
    config: parseConfig(file, fields),
  };
}

/** A copy nothing can write to, for the values a config function builds on
 * rather than edits: what `builtin` and `default` are is settled before the
 * file runs, so a file that tried to edit one is told so where it did it. */
function frozen(value: InstanceConfig): Record<string, unknown> {
  return deepFreeze(copied(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const held of Object.values(value)) deepFreeze(held);
  return Object.freeze(value);
}

/** The mutable copy a config function edits and returns.
 *
 * Without `peers`, which is the one field of a config that no file writes: it
 * is derived from the instances of this host and `peers.json`, so handing it
 * over would be offering a value that is ignored — and a file that returned it
 * unchanged would be returning a field this refuses.  */
function copied(value: InstanceConfig): Record<string, unknown> {
  const { peers: _derived, ...written } = structuredClone(value);
  return written as unknown as Record<string, unknown>;
}

/** One instance's settings, read at the shape the instance uses them. */
export function parseConfig(file: string, fields: Record<string, unknown>): InstanceConfig {
  return {
    harness: harnessOf(file, fields["harness"]),
    // Filled in by whoever read the config home, which is the only place the
    // mesh is known: one file states one instance, and a mesh is every one of
    // them plus what `peers.json` names.
    peers: [],
    ...(fields["endpoint"] === undefined
      ? {}
      : { endpoint: endpointOf(file, "endpoint", fields["endpoint"]) }),
    ...(fields["entry"] === undefined ? {} : { entry: entryOf(file, fields["entry"]) }),
    upstream: upstreamOf(file, fields["upstream"]),
    direct_delivery: flagOf(
      file,
      "direct_delivery",
      fields["direct_delivery"],
      DEFAULT_CONFIG.direct_delivery,
    ),
    fork_origin: flagOf(file, "fork_origin", fields["fork_origin"], DEFAULT_CONFIG.fork_origin),
    dump: dumpOf(file, fields["dump"]),
  };
}

/** One element of a selection: a type name, a prefix of one, either negated
 * with `-`, or `@name` for a preset. Taken from the contract's own schema
 * rather than written again here, so a config file and a request are held to
 * the one spelling. */
const SELECTOR = new RegExp(
  TranscriptItemSelector.pattern ??
    // A selector schema with no pattern would let every string through here,
    // which is the one outcome worse than refusing the config file.
    (() => {
      throw new Error("the contract's item selector states no pattern");
    })(),
);

function dumpOf(file: string, raw: unknown): DumpConfig {
  if (raw === undefined) return { presets: [] };
  const fields = objectOf(file, "dump", raw);
  const presets = presetsOf(file, fields["presets"]);
  // A reference is resolved here rather than at each dump: a cycle or a name
  // nobody configured would otherwise be found once per request, long after
  // the file that holds the mistake was last looked at.
  for (const preset of presets) resolvable(file, preset, presets, []);
  return { presets };
}

function presetsOf(file: string, raw: unknown): DumpPreset[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError(file, "dump.presets must be an array of named selections");
  }
  const names = new Set<string>();
  return raw.map((entry, index) => {
    const at = `dump.presets[${index}]`;
    const fields = objectOf(file, at, entry);
    const name = fields["name"];
    if (typeof name !== "string" || name === "") {
      throw new ConfigError(file, `${at}.name must be a name for the selection`);
    }
    if (names.has(name)) throw new ConfigError(file, `${at}.name repeats ${name}`);
    names.add(name);
    const description = fields["description"];
    if (description !== undefined && typeof description !== "string") {
      throw new ConfigError(file, `${at}.description must be a string`);
    }
    const opts = objectOf(file, `${at}.opts`, fields["opts"]);
    const types = stringsOf(file, `${at}.opts.types`, opts["types"]);
    const wrong = types.filter((element) => !SELECTOR.test(element));
    if (wrong.length > 0) {
      // Named rather than dropped: a selection nothing can match would dump an
      // empty file and say why nowhere. The preset is named beside the strings
      // so the line to edit is the one the message points at.
      throw new ConfigError(
        file,
        `dump.presets[${name}].opts.types must be item types, prefixes, exclusions or @presets, got ${wrong.join(", ")}`,
      );
    }
    return {
      name,
      ...(description === undefined ? {} : { description }),
      opts: { types: [...types] },
    };
  });
}

/** Every `@name` a preset reaches, down through the presets it names.
 *
 * The path is carried so a cycle is named where it closes rather than as a
 * stack that ran out — an operator reading the refusal has to be able to find
 * which two presets point at each other. */
function resolvable(
  file: string,
  preset: DumpPreset,
  presets: readonly DumpPreset[],
  path: readonly string[],
): void {
  if (path.includes(preset.name)) {
    throw new ConfigError(
      file,
      `dump.presets reference each other in a cycle: ${[...path, preset.name].join(" -> ")}`,
    );
  }
  for (const element of preset.opts.types) {
    const name = element.startsWith("-") ? element.slice(1) : element;
    if (!name.startsWith("@")) continue;
    const referenced = presets.find((one) => one.name === name.slice(1));
    if (referenced === undefined) {
      throw new ConfigError(
        file,
        `dump.presets[${preset.name}] names ${name}, which is not configured`,
      );
    }
    resolvable(file, referenced, presets, [...path, preset.name]);
  }
}

function harnessOf(file: string, raw: unknown): Harness {
  if (raw === undefined) return DEFAULT_HARNESS;
  if (!isHarness(raw)) {
    throw new ConfigError(file, `harness must be one of ${HARNESSES.join(", ")}`);
  }
  return raw;
}

function flagOf(file: string, at: string, raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") throw new ConfigError(file, `${at} must be true or false`);
  return raw;
}

/** An endpoint as the contract spells it: the instance's public base URL, with
 * the trailing slash and no route of its own. What hangs below it — `ws`,
 * `mesh/*`, `auth/*`, `webhook/*` — is a route rather than part of the address
 * (contract, `Endpoint`). */
const ENDPOINT = /^https?:\/\/[^\s?#]*\/$/;

function endpointOf(file: string, at: string, raw: unknown): Endpoint {
  if (typeof raw !== "string" || !ENDPOINT.test(raw)) {
    throw new ConfigError(
      file,
      `${at} must be an http:// or https:// base URL ending in /, got ${String(raw)}`,
    );
  }
  return raw as Endpoint;
}

/** `terminal_gateway`'s shape, matched to the contract's `HelloResult` so a
 * value this instance would refuse to report is refused here instead, at
 * startup, rather than on the first `hello`. */
const TERMINAL_GATEWAY = /^https?:\/\/[^/?#\s]+(\/[^?#\s]*[^/?#\s])?$/;

function terminalGatewayOf(file: string, raw: string): string {
  if (!TERMINAL_GATEWAY.test(raw)) {
    throw new ConfigError(
      file,
      `upstream.terminal_gateway must be an http:// or https:// base URL with no trailing slash, got ${raw}`,
    );
  }
  return raw;
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
  const proxies = stringsOf(file, "entry.trusted_proxies", fields["trusted_proxies"]);
  // Read here rather than where a request is: a block that parses to nothing
  // would silently trust nobody, and an operator who wrote one meant to trust
  // somebody.
  const unreadable = proxies.filter((block) => parseCidr(block) === undefined);
  if (unreadable.length > 0) {
    throw new ConfigError(
      file,
      `entry.trusted_proxies must be CIDR blocks, got ${unreadable.join(", ")}`,
    );
  }
  return {
    host,
    port,
    source_ips: stringsOf(file, "entry.source_ips", fields["source_ips"]),
    trusted_proxies: proxies,
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
  if (config["terminal_gateway"] !== undefined) {
    config["terminal_gateway"] = terminalGatewayOf(file, config["terminal_gateway"]);
  }
  const launcher = fields["launcher"];
  return {
    ...(config as UpstreamConfig),
    ...(launcher === undefined ? {} : { launcher: launcherOf(file, launcher) }),
  };
}

/** How deep `dir.tree` walks, and how long a launch may take, when the config
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
