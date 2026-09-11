import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE } from "../src/instance/config.ts";

/** What one command wrote, so a test reads the CLI's answer rather than its
 * return value: the answer is the JSON document, and the number beside it is
 * only whether the command succeeded. */
export interface Written {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export async function capture(run: () => Promise<number>): Promise<Written> {
  const streams = { out: "", err: "" };
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: unknown): boolean => {
    streams.out += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    streams.err += String(chunk);
    return true;
  };
  try {
    const code = await run();
    return { code, out: streams.out, err: streams.err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

export function json(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** Every disposable root a run has made, kept after the directory itself is
 * gone: a process still running against a path that no longer exists is the one
 * thing worth finding here. */
const roots: string[] = [];

/** Say that everything under this directory belongs to the run, so that
 * anything found running against it afterwards is the run's to answer for.
 * Called by `Host` for its own root, and by whoever makes a disposable
 * directory some other way. */
export function trackRoot(dir: string): void {
  roots.push(dir);
}

/** How long a process gets to leave on its own before it is taken. Short: it
 * was asked to stop once already, by whatever ought to have stopped it. */
const REAP_GRACE_MS = 500;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function survivors(): Promise<{ pid: number; argv: string }[]> {
  const ps = Bun.spawn(["ps", "-Ao", "pid=,args="], { stdout: "pipe", stderr: "ignore" });
  const listing = await new Response(ps.stdout).text();
  await ps.exited;
  const found: { pid: number; argv: string }[] = [];
  for (const line of listing.split("\n")) {
    const row = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (row === null) continue;
    const pid = Number(row[1]);
    if (pid === process.pid) continue;
    const argv = row[2] as string;
    if (roots.some((root) => argv.includes(root))) found.push({ pid, argv });
  }
  return found;
}

/** Stop whatever is still running against a disposable root, and name it.
 *
 * A test that leaves a daemon behind leaves it on the person's own machine,
 * holding a socket and writing into a directory that is about to be removed —
 * and a run that ended green would be saying none of that happened. So the
 * survivors are stopped, gently and then not, and returned: the caller asserts
 * the list is empty, which is what turns a leak into a failure rather than
 * into somebody's `ps` output hours later. */
export async function reapOrphans(): Promise<string[]> {
  const leaked = await survivors();
  if (leaked.length === 0) return [];
  for (const one of leaked) {
    try {
      process.kill(one.pid, "SIGTERM");
    } catch {}
  }
  const until = Date.now() + REAP_GRACE_MS;
  while (Date.now() < until && leaked.some((one) => alive(one.pid))) await Bun.sleep(25);
  for (const one of leaked) {
    if (!alive(one.pid)) continue;
    try {
      process.kill(one.pid, "SIGKILL");
    } catch {}
  }
  return leaked.map((one) => one.argv);
}

/** Settings written as the files a person writes: the shared one, one cluster, and
 * one file per instance under `instances/`.
 *
 * Each instance's file is a function assigning what the test states over what
 * it was handed, which is the plainest thing a config file can be — a test
 * about what one instance runs with says the settings and not the ceremony
 * around them. A source string is taken as the whole file, for the tests that
 * are about what a file may do rather than about what it says.
 *
 * The instances are keyed by the name they are listed under; their ids are
 * derived from that name so a test can say what it means and still get the
 * fixed-width id the files are named by. */
export function writeConfigHome(
  configDir: string,
  defaults: Record<string, unknown> | string,
  instances: Readonly<Record<string, Record<string, unknown> | string>> = {},
  peers: readonly string[] = [],
): string {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, CONFIG_FILE), configSource(defaults));
  const ids: string[] = [];
  if (Object.keys(instances).length > 0) {
    mkdirSync(join(configDir, "instances"), { recursive: true });
  }
  for (const [name, settings] of Object.entries(instances)) {
    const id = idFor(name);
    ids.push(id);
    writeFileSync(
      join(configDir, "instances", `instance-${id}.ts`),
      typeof settings === "string" ? settings : configSource({ name, ...settings }),
    );
  }
  const cluster = idFor(`cluster:${configDir}`);
  mkdirSync(join(configDir, "clusters"), { recursive: true });
  writeFileSync(
    join(configDir, "clusters", `cluster-${cluster}.json`),
    `${JSON.stringify({ name: "test", peers, instances: ids }, null, 2)}\n`,
  );
  writeFileSync(
    join(configDir, "clusters.json"),
    `${JSON.stringify({ clusters: [cluster] }, null, 2)}\n`,
  );
  return join(configDir, CONFIG_FILE);
}

/** The id a test's instance is called by: fixed width, and the same every run
 * for the same name, so a test can name a file it wrote. */
export function idFor(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 32);
}

function configSource(settings: Record<string, unknown> | string): string {
  if (typeof settings === "string") return settings;
  return `export default ({ config }: { config: Record<string, unknown> }) => Object.assign(config, ${JSON.stringify(settings)});\n`;
}

/** A host of its own: an XDG config home and state home nobody else uses, with
 * config homes made inside it on demand.
 *
 * `XDG_*` rather than the app's own variables because this is the layout the
 * paths are really resolved through — one shared config file, and a state
 * directory per instance — and the app variables name a single directory, which
 * two instances cannot share. */
export class Host {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly #owned: string[];
  readonly #saved = new Map<string, string | undefined>();

  constructor(prefix = "ccmsg-host-") {
    this.root = mkdtempSync(join(tmpdir(), prefix));
    this.#owned = [this.root];
    trackRoot(this.root);
    this.env = {
      XDG_CONFIG_HOME: join(this.root, "config"),
      XDG_STATE_HOME: join(this.root, "state"),
      HOME: this.root,
    };
  }

  /** A config home, made to look like one: the harness's own `settings.json` is
   * what the daemon checks for. */
  home(name: string, settings = true): string {
    const dir = join(this.root, name);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    if (settings) writeFileSync(join(dir, "settings.json"), "{}\n");
    return dir;
  }

  /** Put this host into the process environment, which is where the CLI's
   * commands read it from. */
  adopt(): void {
    for (const [name, value] of Object.entries(this.env)) {
      if (!this.#saved.has(name)) this.#saved.set(name, process.env[name]);
      process.env[name] = value;
    }
    for (const name of ["CCMSG_CONFIG_DIR", "CCMSG_STATE_DIR", "CLAUDE_CONFIG_DIR"]) {
      if (!this.#saved.has(name)) this.#saved.set(name, process.env[name]);
      delete process.env[name];
    }
  }

  release(): void {
    for (const [name, value] of this.#saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    this.#saved.clear();
    for (const dir of this.#owned.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
}
