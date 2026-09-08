import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CommandError, ENTRY } from "../daemon/registry.ts";
import { type Env, resolveStateRoot } from "../instance/paths.ts";

/** What the host's init system was asked, and what it said.
 *
 * A function rather than a call to `Bun.spawn` in place, so a test drives
 * register and unregister without `launchctl` or `systemctl` on the real host
 * ever hearing about it. */
export type Run = (command: readonly string[]) => Promise<RunResult>;

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const runCommand: Run = async (command) => {
  const proc = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** What `service status` answers about the supervisor itself. The instances are
 * added by the caller, which is the one that can ask them. */
export interface ServiceState {
  readonly registered: boolean;
  readonly running: boolean;
  readonly pid?: number;
  /** What the init system itself says, or `null` when it could not be asked.
   *
   * Beside the two fields above rather than folded into them: those are ccmsg's
   * reading, and this is the host's — a supervisor the file registers but
   * launchd never loaded is a disagreement worth being able to see. */
  readonly service: ServiceReport | null;
}

/** The init system's own account of the supervisor, at the few points that say
 * whether it is up and why it last was not. Every field is `null` when the
 * answer did not carry it. */
export interface ServiceReport {
  /** The init system's own word for the state, unread: `running`,
   * `not running`, `active`, `failed`. */
  readonly state: string | null;
  readonly loaded: boolean | null;
  readonly running: boolean | null;
  readonly pid: number | null;
  /** What the last run exited with. The reason a supervisor that is not there
   * is not there. */
  readonly last_exit: number | null;
}

const UNKNOWN: ServiceReport = {
  state: null,
  loaded: null,
  running: null,
  pid: null,
  last_exit: null,
};

/** One host's way of being told to keep a program running.
 *
 * The two implementations differ in every detail and agree on the shape: a file
 * that describes the program, a command that puts it in front of the init
 * system, and a way to ask what became of it. */
export interface Service {
  readonly kind: "launchd" | "systemd";
  /** The file that describes the supervisor to the init system. */
  readonly unitFile: string;
  /** What that file says. Exposed so a test reads what would be written. */
  unitText(): string;
  register(run: Run): Promise<ServiceState>;
  unregister(run: Run): Promise<{ unregistered: boolean }>;
  /** Where this host keeps what the supervisor said: a file on one, a command
   * on the other. Two shapes rather than one because they are two different
   * things — launchd is told a path to redirect to, and systemd hands its
   * units' output to the journal, which is read by asking for it. */
  logSource(): LogSource;
  start(run: Run): Promise<ServiceState>;
  stop(run: Run): Promise<ServiceState>;
  state(run: Run): Promise<ServiceState>;
}

export type LogSource =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "command"; readonly show: string[]; readonly follow: string[] };

/** The program the init system is asked to keep running, and the environment it
 * has to be given.
 *
 * The interpreter and script are this process's own (`ENTRY`'s reasoning), and
 * the environment carries the variables that decide which files ccmsg uses: an
 * init system starts a program with almost nothing set, so a supervisor
 * registered from a shell where these were exported and started without them
 * would quietly manage a different set of instances. */
function supervisorCommand(): string[] {
  return [process.execPath, ENTRY, "daemon", "supervise"];
}

const CARRIED = [
  "PATH",
  "HOME",
  "CCMSG_CONFIG_DIR",
  "CCMSG_STATE_DIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
] as const;

function carriedEnv(env: Env): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const name of CARRIED) {
    const value = env[name];
    if (value !== undefined && value !== "") carried[name] = value;
  }
  return carried;
}

/** Where the supervisor's own output goes.
 *
 * Beside the instances' state rather than in a per-instance directory: the
 * supervisor belongs to no single config home, and `service log` is the one
 * reader of it. On systemd the unit's output goes to the journal instead,
 * which is where a user unit's output is read from and what `service log`
 * asks there. */
export function serviceLogFile(env: Env = process.env): string {
  return join(resolveStateRoot(env), "service.log");
}

export const LAUNCHD_LABEL = "com.github.kawaz.ccmsg";
export const SYSTEMD_UNIT = "ccmsg.service";

/** The service for this host, or a refusal on a host that has neither. */
export function serviceFor(env: Env = process.env, platform = process.platform): Service {
  if (platform === "darwin") return new LaunchdService(env);
  if (platform === "linux") return new SystemdService(env);
  throw new CommandError("capability_unavailable", `${platform} には登録先がありません`);
}

class LaunchdService implements Service {
  readonly kind = "launchd" as const;
  readonly unitFile: string;
  readonly #env: Env;
  readonly #domain: string;

  constructor(env: Env) {
    this.#env = env;
    const home = env["HOME"] ?? homedir();
    this.unitFile = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    this.#domain = `gui/${String(process.getuid?.() ?? 0)}`;
  }

  /** `KeepAlive` rather than `RunAtLoad` alone: launchd restarting the
   * supervisor is the outer half of the same job the supervisor does for its
   * instances, and it is what makes a login survive the supervisor crashing. */
  unitText(): string {
    const log = serviceLogFile(this.#env);
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...supervisorCommand().map((arg) => `    <string>${escapeXml(arg)}</string>`),
      "  </array>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      ...Object.entries(carriedEnv(this.#env)).map(
        ([name, value]) => `    <key>${name}</key><string>${escapeXml(value)}</string>`,
      ),
      "  </dict>",
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      `  <key>StandardOutPath</key><string>${escapeXml(log)}</string>`,
      `  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
  }

  async register(run: Run): Promise<ServiceState> {
    write(this.unitFile, this.unitText(), serviceLogFile(this.#env));
    await run(["launchctl", "bootstrap", this.#domain, this.unitFile]);
    return await this.state(run);
  }

  async unregister(run: Run): Promise<{ unregistered: boolean }> {
    await run(["launchctl", "bootout", `${this.#domain}/${LAUNCHD_LABEL}`]);
    const existed = existsSync(this.unitFile);
    rmSync(this.unitFile, { force: true });
    return { unregistered: existed };
  }

  async start(run: Run): Promise<ServiceState> {
    await run(["launchctl", "kickstart", `${this.#domain}/${LAUNCHD_LABEL}`]);
    return await this.state(run);
  }

  async stop(run: Run): Promise<ServiceState> {
    await run(["launchctl", "kill", "SIGTERM", `${this.#domain}/${LAUNCHD_LABEL}`]);
    return await this.state(run);
  }

  async state(run: Run): Promise<ServiceState> {
    const registered = existsSync(this.unitFile);
    const printed = await run(["launchctl", "print", `${this.#domain}/${LAUNCHD_LABEL}`]);
    // A non-zero exit is launchd saying it has no such service, which is not
    // the same as having nothing to say: the report stays `null` only when the
    // question could not be put, and here it was and the answer was "no".
    if (printed.code !== 0) {
      return { registered, running: false, service: { ...UNKNOWN, loaded: false } };
    }
    // `launchctl print` states the pid only while there is a process; a service
    // that is loaded and not running prints its state without one.
    const pid = field(/^\s*pid = (\d+)$/m, printed.stdout);
    const service: ServiceReport = {
      state: /^\s*state = (.+)$/m.exec(printed.stdout)?.[1]?.trim() ?? null,
      loaded: true,
      running: pid !== null,
      pid,
      last_exit: field(/^\s*last exit (?:code|status) = (-?\d+)$/m, printed.stdout),
    };
    if (pid === null) return { registered, running: false, service };
    return { registered, running: true, pid, service };
  }

  /** Where launchd was told to put the supervisor's output. */
  logSource(): LogSource {
    return { kind: "file", file: serviceLogFile(this.#env) };
  }
}

class SystemdService implements Service {
  readonly kind = "systemd" as const;
  readonly unitFile: string;
  readonly #env: Env;

  constructor(env: Env) {
    this.#env = env;
    const home = env["HOME"] ?? homedir();
    const config = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
    this.unitFile = join(config, "systemd", "user", SYSTEMD_UNIT);
  }

  /** `Restart=always` for `KeepAlive`'s reason, and `default.target` because a
   * user service belongs to the user's session rather than to the boot. */
  unitText(): string {
    const environment = Object.entries(carriedEnv(this.#env)).map(
      ([name, value]) => `Environment=${name}=${value}`,
    );
    return [
      "[Unit]",
      "Description=ccmsg instance supervisor",
      "",
      "[Service]",
      `ExecStart=${supervisorCommand().join(" ")}`,
      ...environment,
      "Restart=always",
      "RestartSec=1",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }

  /** The journal, which is where a user unit's output goes: systemd is not told
   * a path, so there is no file to tail and the log is asked for instead. */
  logSource(): LogSource {
    const unit = ["journalctl", "--user", "-u", SYSTEMD_UNIT];
    return { kind: "command", show: [...unit, "--no-pager"], follow: [...unit, "-f"] };
  }

  async register(run: Run): Promise<ServiceState> {
    write(this.unitFile, this.unitText(), serviceLogFile(this.#env));
    await run(["systemctl", "--user", "daemon-reload"]);
    await run(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT]);
    return await this.state(run);
  }

  async unregister(run: Run): Promise<{ unregistered: boolean }> {
    await run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
    const existed = existsSync(this.unitFile);
    rmSync(this.unitFile, { force: true });
    await run(["systemctl", "--user", "daemon-reload"]);
    return { unregistered: existed };
  }

  async start(run: Run): Promise<ServiceState> {
    await run(["systemctl", "--user", "start", SYSTEMD_UNIT]);
    return await this.state(run);
  }

  async stop(run: Run): Promise<ServiceState> {
    await run(["systemctl", "--user", "stop", SYSTEMD_UNIT]);
    return await this.state(run);
  }

  async state(run: Run): Promise<ServiceState> {
    const registered = existsSync(this.unitFile);
    const shown = await run([
      "systemctl",
      "--user",
      "show",
      SYSTEMD_UNIT,
      "--property=MainPID",
      "--property=ActiveState",
      "--property=LoadState",
      "--property=ExecMainStatus",
    ]);
    if (shown.code !== 0) return { registered, running: false, service: null };
    const fields = new Map(
      shown.stdout
        .split("\n")
        .map((line) => line.split("="))
        .filter((pair): pair is [string, string] => pair.length === 2)
        .map(([name, value]) => [name as string, value as string]),
    );
    const pid = Number(fields.get("MainPID") ?? "0");
    const running = fields.get("ActiveState") === "active" && pid > 0;
    const exit = fields.get("ExecMainStatus");
    const service: ServiceReport = {
      state: fields.get("ActiveState") ?? null,
      loaded: fields.get("LoadState") === "loaded",
      running,
      pid: pid > 0 ? pid : null,
      last_exit: exit === undefined || exit === "" ? null : Number(exit),
    };
    return { registered, running, ...(running ? { pid } : {}), service };
  }
}

/** Lay the unit down, and make sure the log it names has a directory. */
function write(file: string, text: string, log: string): void {
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(file, text);
}

/** One number a report names, or `null` when the answer did not name it. */
function field(pattern: RegExp, text: string): number | null {
  const found = pattern.exec(text)?.[1];
  return found === undefined ? null : Number(found);
}

function escapeXml(text: string): string {
  return text.replace(/[&<>]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;",
  );
}
