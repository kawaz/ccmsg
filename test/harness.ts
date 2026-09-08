import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
