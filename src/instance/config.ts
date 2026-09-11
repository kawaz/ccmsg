import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
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
  /** Every instance of the mesh, this one among them (§7.1).
   *
   * Data, and the same data on every host: a settings function is handed it
   * and may read it — an instance that wants to know who else there is has it
   * here — but a returned list that differs from the file's is refused. Which
   * entry is this instance is the row carrying its own id, which is what
   * settles `endpoint` below. */
  readonly endpoints: readonly EndpointRow[];
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

/** An instance with no config file: the unix socket, no mesh, no upstreams.
 *
 * Absent is not broken. A config that is not there states nothing wrong, while
 * one that is there and unreadable states something wrong — only the second is
 * the fail-fast case. */
export const DEFAULT_CONFIG: InstanceConfig = {
  harness: DEFAULT_HARNESS,
  endpoints: [],
  upstream: {},
  direct_delivery: true,
  fork_origin: false,
  dump: { presets: [] },
};

/** The file every instance's settings start from, and the directory holding
 * one file per instance. Both are read from the config home a person edits
 * (§8.2). The names are held here alone, so what the files are called is one
 * edit rather than a search. */
export const CONFIG_FILE = "config_v2.ts";
export const INSTANCES_DIR = "instances";

/** The declarations a config file writes against, as they are called where
 * they are copied to, and as this build keeps them. */
export const TYPES_FILE = "ccmsg-config_v2.d.ts";
const TYPES_SOURCE = "ccmsg-config.d.ts";

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

/** The mesh, as data: who is in it and where each one is reached.
 *
 * A list rather than something derived, because it is the one thing an
 * instance cannot work out for itself — which address of the several a host
 * has is the one its peers dial, and which of the entries is this instance.
 * Both are answered by the row carrying its own id, which is what settles
 * `self` (§7.1) without asking the network anything.
 *
 * Every instance of the mesh is in it, this host's and the others', so one
 * file can be copied to every host unchanged (§8.2). */
export const ENDPOINTS_FILE = "endpoints.json";

/** Which of them this host starts. An id here and not in the endpoints is a
 * mistake; an id in the endpoints and not here is another host's instance,
 * which this one dials and does not start. */
export const SUPERVISOR_FILE = "supervisor.json";

/** Where the settings that were read and checked are kept, and the one file
 * the supervisor and every instance actually read.
 *
 * Apart from the files a person edits because the two answer different
 * questions: what is being written, and what is running. A config that does
 * not check out never reaches here, which is what lets a broken edit be
 * reported without taking the host down (§8.3). */
export const STATE_CONFIG_DIR = "config";
export const SATISFIED_FILE = "satisfied.json";
export const REJECTED_DIR = "config.rejected";

/** One entry of the mesh. */
export interface EndpointRow {
  readonly id: string;
  readonly endpoint: Endpoint;
}

/** What one instance is, once its file has been read. */
export interface InstanceSetting {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly config: InstanceConfig;
}

/** Everything that was read, checked, and is therefore what runs.
 *
 * One value rather than a directory to walk: the supervisor and the instances
 * read this and nothing else, so what they run with is what was checked, and
 * no TypeScript is evaluated a second time where a different answer could come
 * back. */
export interface Satisfied {
  readonly endpoints: readonly EndpointRow[];
  readonly supervisor: { readonly instances: readonly string[] };
  readonly instances: readonly InstanceSetting[];
}

/** A label a person may give an instance. Narrow because it is typed at a
 * command and printed in a listing; nothing is found by it, since files are
 * named by id. */
export const CONFIG_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Something wrong with one file, said where it is: which file, and what about
 * it. Collected rather than thrown one at a time, so an operator who broke two
 * things is told about both. */
export interface ConfigProblem {
  readonly file: string;
  readonly msg: string;
}

/** The files this reads, at the paths they are read and copied by. */
export function configFiles(configDir: string, instances: readonly string[]): string[] {
  return [
    join(configDir, CONFIG_FILE),
    join(configDir, ENDPOINTS_FILE),
    join(configDir, SUPERVISOR_FILE),
    ...instances.map((id) => join(configDir, INSTANCES_DIR, instanceFileName(id))),
  ];
}

export function instanceFileName(id: string): string {
  return `instance-${id}.ts`;
}

/** Read everything a person edits, call what has to be called, and check the
 * whole of it (DV-Q8, §8.3).
 *
 * One pass rather than a check per file, because what makes a config right is
 * mostly between files: an id the supervisor starts has to be an entry of the
 * mesh and have settings of its own, two instances must not hold one address
 * or one config home, and the data is the mesh — a settings function that
 * returned a different one has stated something it does not get to state. Each
 * file is checked as far as it can be on its own so that a person is told
 * where the mistake is, and nothing is applied until all of it holds.
 *
 * The settings functions are called here and never again: what they returned
 * is what runs. They are expected to have no side effects, since this runs
 * them to answer questions — `config show`, `config diff --satisfied` — as well as
 * to apply them. */
export async function evaluate(
  configDir: string,
): Promise<{ satisfied?: Satisfied; problems: readonly ConfigProblem[] }> {
  const problems: ConfigProblem[] = [];
  const at = (file: string, msg: string): undefined => {
    problems.push({ file, msg });
    return undefined;
  };

  const endpointsFile = join(configDir, ENDPOINTS_FILE);
  const supervisorFile = join(configDir, SUPERVISOR_FILE);
  const configFile = join(configDir, CONFIG_FILE);

  const endpoints = readEndpoints(endpointsFile, at);
  const supervised = readSupervisor(supervisorFile, at);

  // An empty config home is not a broken one: nothing is being run, which is
  // what a host that has had no `daemon add` looks like.
  if (endpoints === undefined || supervised === undefined) {
    if (problems.length > 0) return { problems };
    return {
      satisfied: { endpoints: [], supervisor: { instances: [] }, instances: [] },
      problems,
    };
  }

  const defaults = await defaultsOf(configFile, endpoints, at);
  const instances: InstanceSetting[] = [];
  for (const id of supervised) {
    if (!endpoints.some((row) => row.id === id)) {
      at(supervisorFile, `${id} is not an entry of ${ENDPOINTS_FILE}`);
      continue;
    }
    const file = join(configDir, INSTANCES_DIR, instanceFileName(id));
    if (!existsSync(file)) {
      at(supervisorFile, `${id} has no settings of its own at ${file}`);
      continue;
    }
    if (defaults === undefined) continue;
    const read = await instanceOf(file, id, defaults, endpoints, at);
    if (read !== undefined) instances.push(read);
  }

  // What no single file can be wrong about on its own.
  const dirs = new Map<string, string>();
  const ports = new Map<number, string>();
  for (const one of instances) {
    const file = join(configDir, INSTANCES_DIR, instanceFileName(one.id));
    const home = dirs.get(one.dir);
    if (home !== undefined) at(file, `dir ${one.dir} is already what ${home} answers for`);
    else dirs.set(one.dir, one.name);
    const port = one.config.entry?.port;
    if (port === undefined || port === 0) continue;
    const held = ports.get(port);
    if (held !== undefined) at(file, `port ${String(port)} is already ${held}'s`);
    else ports.set(port, one.name);
  }

  if (problems.length > 0) return { problems };
  return {
    satisfied: { endpoints, supervisor: { instances: supervised }, instances },
    problems,
  };
}

/** The mesh as the data states it. */
function readEndpoints(
  file: string,
  at: (file: string, msg: string) => undefined,
): readonly EndpointRow[] | undefined {
  const parsed = readJson(file, at);
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed)) return at(file, "must be an array of {id, endpoint}");
  const rows: EndpointRow[] = [];
  for (const [index, raw] of parsed.entries()) {
    const where = `[${String(index)}]`;
    if (typeof raw !== "object" || raw === null) {
      at(file, `${where} must be an object with id and endpoint`);
      continue;
    }
    const fields = raw as Record<string, unknown>;
    const id = fields["id"];
    const endpoint = fields["endpoint"];
    if (typeof id !== "string" || !ID.test(id)) {
      at(file, `${where}.id must be an instance id`);
      continue;
    }
    if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint)) {
      at(file, `${where}.endpoint must be an http:// or https:// base URL ending in /`);
      continue;
    }
    if (rows.some((row) => row.id === id)) at(file, `${where}.id repeats ${id}`);
    else if (rows.some((row) => row.endpoint === endpoint)) {
      // Two entries at one address would each be this instance to whoever
      // dialled it, and neither could be told from the other (§7.1).
      at(file, `${where}.endpoint repeats ${endpoint}`);
    } else rows.push({ id, endpoint: endpoint as Endpoint });
  }
  return rows;
}

function readSupervisor(
  file: string,
  at: (file: string, msg: string) => undefined,
): readonly string[] | undefined {
  const parsed = readJson(file, at);
  if (parsed === undefined) return undefined;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return at(file, "must be an object with instances");
  }
  const listed = (parsed as Record<string, unknown>)["instances"] ?? [];
  if (!Array.isArray(listed) || listed.some((id) => typeof id !== "string" || !ID.test(id))) {
    return at(file, "instances must be an array of instance ids");
  }
  const ids = listed as string[];
  const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (twice.length > 0) return at(file, `instances repeats ${[...new Set(twice)].join(", ")}`);
  return ids;
}

/** What every instance starts from. */
async function defaultsOf(
  file: string,
  endpoints: readonly EndpointRow[],
  at: (file: string, msg: string) => undefined,
): Promise<InstanceConfig | undefined> {
  if (!existsSync(file)) {
    const legacy = join(dirname(file), JSON_FILE);
    if (existsSync(legacy)) {
      return at(
        legacy,
        `settings are TypeScript now: write ${file}, ${join(dirname(file), ENDPOINTS_FILE)} and ${join(dirname(file), SUPERVISOR_FILE)}`,
      );
    }
    return { ...DEFAULT_CONFIG, endpoints };
  }
  const returned = await called(file, {
    builtin: frozen({ ...DEFAULT_CONFIG, endpoints }),
    config: copied({ ...DEFAULT_CONFIG, endpoints }),
  });
  if (returned.problem !== undefined) return at(file, returned.problem);
  return settingsOf(file, returned.value, endpoints, false, at)?.config;
}

/** One instance's own file, read over what the shared one returned. */
async function instanceOf(
  file: string,
  id: string,
  defaults: InstanceConfig,
  endpoints: readonly EndpointRow[],
  at: (file: string, msg: string) => undefined,
): Promise<InstanceSetting | undefined> {
  const returned = await called(file, {
    builtin: frozen({ ...DEFAULT_CONFIG, endpoints }),
    default: frozen(defaults),
    config: { ...copied(defaults), dir: "", name: id },
  });
  if (returned.problem !== undefined) return at(file, returned.problem);
  const read = settingsOf(file, returned.value, endpoints, true, at);
  if (read === undefined) return undefined;
  // Where this instance is reached: its own row of the mesh. An instance the
  // data does not name could not be dialled by anybody and could not settle
  // what a handshake calls it (§7.1), so it is a config error rather than an
  // instance with no address.
  const mine = endpoints.find((row) => row.id === id);
  if (mine === undefined) {
    return at(file, `${id} is not an entry of ${ENDPOINTS_FILE}, so it has no endpoint`);
  }
  return {
    id,
    name: read.name === "" ? id : read.name,
    dir: read.dir,
    config: { ...read.config, endpoint: mine.endpoint },
  };
}

/** The settings that were applied, as the state directory holds them. */
export function applied(stateRoot: string): Satisfied | undefined {
  let text: string;
  try {
    text = readFileSync(join(stateRoot, STATE_CONFIG_DIR, SATISFIED_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as Satisfied;
  } catch {
    return undefined;
  }
}

/** Write down what checked out: the value the supervisor and the instances
 * read, and a copy of each file it was read from.
 *
 * The copies are what `config diff` compares against and what `config revert`
 * puts back, so they are taken at the same relative paths. Only the files
 * named above are copied: what a settings file imports is its own business and
 * is not backed up here, and a config home that loses one of those still
 * starts, because what starts an instance is the value and not the file. */
export function apply(configDir: string, stateRoot: string, satisfied: Satisfied): void {
  const into = join(stateRoot, STATE_CONFIG_DIR);
  mkdirSync(join(into, INSTANCES_DIR), { recursive: true });
  for (const file of configFiles(configDir, satisfied.supervisor.instances)) {
    if (!existsSync(file)) continue;
    copyFileSync(file, join(into, relative(configDir, file)));
  }
  writeFileSync(join(into, SATISFIED_FILE), `${JSON.stringify(satisfied, null, 2)}\n`);
}

/** Read, check, and apply, which is the one thing startup and reload both do.
 *
 * A config that does not check out leaves the applied one standing and is
 * reported: an instance already serving a session is not something a typo in a
 * file should take away, and an operator finds out from the log and from
 * `daemon status` rather than from everything being gone. The first run is the
 * exception — there is nothing to fall back to, so there is nothing to run. */
export async function settle(
  configDir: string,
  stateRoot: string,
): Promise<{ satisfied: Satisfied; problems: readonly ConfigProblem[]; applied: boolean }> {
  const read = await evaluate(configDir);
  if (read.satisfied !== undefined) {
    apply(configDir, stateRoot, read.satisfied);
    return { satisfied: read.satisfied, problems: [], applied: true };
  }
  const standing = applied(stateRoot);
  if (standing === undefined) {
    throw new ConfigError(
      read.problems[0]?.file ?? join(configDir, CONFIG_FILE),
      read.problems.map((one) => `${one.file}: ${one.msg}`).join("; "),
    );
  }
  return { satisfied: standing, problems: read.problems, applied: false };
}

/** What one config home's instance runs with, out of what is applied. */
export function configOf(satisfied: Satisfied, dir: string): InstanceSetting | undefined {
  return satisfied.instances.find((one) => one.dir === dir);
}

function readJson(file: string, at: (file: string, msg: string) => undefined): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    return at(file, `not valid JSON (${String(cause)})`);
  }
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
  copyFileSync(new URL(`./${TYPES_SOURCE}`, import.meta.url).pathname, at);
  return at;
}

/** Import one config file and call what it exports.
 *
 * The modified time rides on the specifier because an import is cached by it:
 * a file read again in the same process after being edited — a supervisor
 * asked to add an instance, a test writing two configs — would otherwise be
 * the first read over again. */
async function called(
  file: string,
  ctx: Record<string, unknown>,
): Promise<{ value?: unknown; problem?: string }> {
  let module: { default?: unknown };
  try {
    module = (await import(`${file}?mtime=${String(statSync(file).mtimeMs)}`)) as {
      default?: unknown;
    };
  } catch (cause) {
    return { problem: `cannot be loaded (${String(cause)})` };
  }
  const define = module.default;
  if (typeof define !== "function") {
    return { problem: "must default export a function taking { config } and returning it" };
  }
  try {
    // Awaited whatever it answers with: what a settings file has to do to
    // answer — read a secret, ask something — is its own business.
    return { value: await (define as (given: unknown) => unknown)(ctx) };
  } catch (cause) {
    return { problem: `threw while being read (${String(cause)})` };
  }
}

/** What one config function handed back, checked at the shape an instance uses
 * it. */
function settingsOf(
  file: string,
  returned: unknown,
  endpoints: readonly EndpointRow[],
  wantsDir: boolean,
  at: (file: string, msg: string) => undefined,
): { dir: string; name: string; config: InstanceConfig } | undefined {
  if (typeof returned !== "object" || returned === null || Array.isArray(returned)) {
    return at(file, "must return the config it was handed");
  }
  const fields = returned as Record<string, unknown>;
  for (const name of Object.keys(fields)) {
    if ((INSTANCE_FIELDS as readonly string[]).includes(name)) {
      if (wantsDir) continue;
      return at(file, `${name} belongs to an ${INSTANCES_DIR}/ file, which this is not`);
    }
    if (name === "endpoints") continue;
    if (!(FIELDS as readonly string[]).includes(name)) {
      return at(file, `unknown field ${name}; expected ${FIELDS.join(", ")}`);
    }
  }
  // The mesh is data: a function is handed it so it can read it, and a
  // function that handed back a different one has stated something that is
  // not its to state — which would be a host running a mesh nobody wrote down.
  if (!sameMesh(fields["endpoints"], endpoints)) {
    return at(
      file,
      `endpoints are ${ENDPOINTS_FILE}'s to state, and this returned a different list`,
    );
  }
  const dir = fields["dir"];
  if (wantsDir && (typeof dir !== "string" || !isAbsolute(dir))) {
    return at(file, "dir must be the absolute config home this instance answers for");
  }
  const name = fields["name"];
  if (name !== undefined && (typeof name !== "string" || !CONFIG_NAME.test(name))) {
    return at(file, "name must be a label in lower case, digits, dots, dashes");
  }
  let config: InstanceConfig;
  try {
    config = parseConfig(file, fields);
  } catch (cause) {
    return at(
      file,
      cause instanceof ConfigError ? cause.message.slice(file.length + 2) : String(cause),
    );
  }
  return {
    dir: wantsDir ? (dir as string) : "",
    name: typeof name === "string" ? name : "",
    config: { ...config, endpoints },
  };
}

/** Whether what came back is the mesh that went in, row by row.
 *
 * Field by field rather than by serialising the two: what is being asked is
 * whether a settings function changed anything, and two lists that differ in
 * the order of their keys are the same mesh. */
function sameMesh(returned: unknown, rows: readonly EndpointRow[]): boolean {
  if (!Array.isArray(returned)) return rows.length === 0;
  if (returned.length !== rows.length) return false;
  return rows.every((row, at) => {
    const one = returned[at] as { id?: unknown; endpoint?: unknown } | undefined;
    return one?.id === row.id && one.endpoint === row.endpoint;
  });
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
 * The mesh is in it, because a settings function may want to read who else
 * there is; handing back a different one is what is refused. */
function copied(value: InstanceConfig): Record<string, unknown> {
  return structuredClone(value) as unknown as Record<string, unknown>;
}

/** One instance's settings, read at the shape the instance uses them. */
export function parseConfig(file: string, fields: Record<string, unknown>): InstanceConfig {
  return {
    harness: harnessOf(file, fields["harness"]),
    // Put back by the caller from the data, which is where the mesh is
    // stated; what a settings function returned has already been held to it.
    endpoints: [],
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
