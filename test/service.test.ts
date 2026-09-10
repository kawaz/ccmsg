import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENTRY } from "../src/daemon/registry.ts";
import {
  LAUNCHD_LABEL,
  LaunchdService,
  type Run,
  type RunResult,
  serviceFor,
  serviceLogFile,
  SYSTEMD_UNIT,
} from "../src/service/index.ts";
import { durable, registeredProgram, supervisorProgram } from "../src/service/program.ts";
import { Host } from "./harness.ts";

const hosts: Host[] = [];

function host(): Host {
  const one = new Host("ccmsg-service-");
  hosts.push(one);
  return one;
}

afterEach(() => {
  for (const one of hosts.splice(0)) one.release();
});

/** The unit file on disk and nothing else done: what a login finds, and what a
 * `register` interrupted before it reached the init system leaves behind. */
function laid(service: { unitFile: string; unitText(): string }): void {
  mkdirSync(dirname(service.unitFile), { recursive: true });
  writeFileSync(service.unitFile, service.unitText());
}

/** The init system, recorded rather than run: registering for real would put a
 * supervisor in front of this machine's launchd, which a test has no business
 * doing. */
function recorder(answer: (command: readonly string[]) => Partial<RunResult> = () => ({})): {
  run: Run;
  commands: string[][];
} {
  const commands: string[][] = [];
  return {
    commands,
    run: (command) => {
      commands.push([...command]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "", ...answer(command) });
    },
  };
}

/** A launchd that starts out not knowing this label, and knows it once it has
 * been bootstrapped — which is what makes the order of the commands mean
 * something rather than every answer being a bare zero. */
function fakeLaunchd(): { run: Run; commands: string[][] } {
  let loaded = false;
  return recorder((command) => {
    if (command[1] === "bootstrap") {
      loaded = true;
      return {};
    }
    if (command[1] === "print") {
      return loaded ? { stdout: "\tstate = running\n\tpid = 4242\n" } : { code: 113 };
    }
    return loaded ? {} : { code: 3, stderr: "No such process" };
  });
}

describe("launchd", () => {
  test("register writes the agent and hands it to launchd; unregister takes both back", async () => {
    const at = host();
    const service = serviceFor(at.env, "darwin");
    const launchctl = fakeLaunchd();

    await service.register(launchctl.run);
    expect(service.unitFile).toEndWith(`LaunchAgents/${LAUNCHD_LABEL}.plist`);
    const plist = readFileSync(service.unitFile, "utf8");
    // What the agent runs is this build's own supervisor, not a name resolved
    // again through PATH.
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>supervise</string>");
    expect(plist).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    // The variables that decide which files ccmsg uses travel with it: an agent
    // started without them would supervise another set of instances.
    expect(plist).toContain(
      `<key>XDG_CONFIG_HOME</key><string>${at.env["XDG_CONFIG_HOME"]}</string>`,
    );
    expect(launchctl.commands.map((command) => command[1])).toEqual([
      "print",
      "bootstrap",
      "kickstart",
      "print",
    ]);

    const gone = await service.unregister(launchctl.run);
    expect(gone).toEqual({ unregistered: true });
    expect(existsSync(service.unitFile)).toBe(false);
    expect(launchctl.commands.at(-1)?.slice(0, 2)).toEqual(["launchctl", "bootout"]);
  });

  test("start puts a unit launchd has never heard of in front of it before kicking it", async () => {
    const at = host();
    const service = serviceFor(at.env, "darwin");
    // The state a login leaves behind, and the state an `unregister` leaves
    // behind however quickly a `register` follows it: the file is there and
    // launchd knows nothing about the label. `kickstart` alone answers
    // `No such process` and the supervisor never runs.
    const launchctl = fakeLaunchd();
    laid(service);

    const state = await service.start(launchctl.run);
    expect(launchctl.commands.map((command) => command[1])).toEqual([
      "print",
      "bootstrap",
      "kickstart",
      "print",
    ]);
    expect(state).toMatchObject({ registered: true, running: true, pid: 4242 });
  });

  test("a unit launchd already holds is kicked and not bootstrapped again", async () => {
    const at = host();
    const service = serviceFor(at.env, "darwin");
    const launchctl = recorder(() => ({ stdout: "\tstate = not running\n" }));
    laid(service);

    await service.start(launchctl.run);
    expect(launchctl.commands.map((command) => command[1])).toEqual([
      "print",
      "kickstart",
      "print",
    ]);
  });

  test("a start launchd refuses is said out loud rather than answered as a state", async () => {
    const at = host();
    const service = serviceFor(at.env, "darwin");
    // A bootstrap that fails is why a `service status` can say the file is
    // registered while nothing is running: the refusal used to go unread.
    const refusing = recorder((command) =>
      command[1] === "bootstrap"
        ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error" }
        : { code: 113 },
    );
    laid(service);
    const refused = await service.start(refusing.run).catch((cause: unknown) => String(cause));
    expect(refused).toContain("Input/output error");

    // Except when the refusal is launchd saying the unit is already there,
    // which is what this asked for in the first place.
    let bootstrapped = false;
    const busy = recorder((command) => {
      if (command[1] === "bootstrap") {
        bootstrapped = true;
        return { code: 37, stderr: "Bootstrap failed: 37: Operation already in progress" };
      }
      if (command[1] === "print" && !bootstrapped) return { code: 113 };
      return { stdout: "\tstate = running\n\tpid = 9\n" };
    });
    expect(await service.start(busy.run)).toMatchObject({ running: true, pid: 9 });
  });

  test("status reads the pid launchd prints, and says not running when there is none", async () => {
    const at = host();
    const service = serviceFor(at.env, "darwin");
    await service.register(recorder().run);

    const withPid = await service.state(
      recorder(() => ({
        stdout: "\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n",
      })).run,
    );
    expect(withPid).toEqual({
      registered: true,
      running: true,
      pid: 4242,
      program: { path: expect.any(String), durable: true, exists: true },
      service: { state: "running", loaded: true, running: true, pid: 4242, last_exit: 0 },
    });

    // Loaded and not running: what launchd says is why, which is the field
    // ccmsg's own two booleans cannot carry.
    const loadedOnly = await service.state(
      recorder(() => ({ stdout: "\tstate = not running\n\tlast exit code = 1\n" })).run,
    );
    expect(loadedOnly).toEqual({
      registered: true,
      running: false,
      program: { path: expect.any(String), durable: true, exists: true },
      service: { state: "not running", loaded: true, running: false, pid: null, last_exit: 1 },
    });

    // A service launchd does not know about is not running whatever the file
    // says, and the disagreement is visible rather than smoothed over.
    const unknown = await service.state(recorder(() => ({ code: 113 })).run);
    expect(unknown).toMatchObject({ registered: true, running: false });
    expect(unknown.service).toEqual({
      state: null,
      loaded: false,
      running: null,
      pid: null,
      last_exit: null,
    });
  });

  /** A launchd holding the label, until it is booted out of it.
   *
   * `KeepAlive` is the thing being tested around, so this answers the way one
   * does: a label it still holds has a process, and a process that goes while
   * the label is held comes back with a new pid. */
  function keepingAlive(pid = 4242): {
    run: Run;
    commands: string[][];
    /** Whether the process is there, which `kill -0` is asked about. */
    running: () => boolean;
  } {
    let held = true;
    let alive = true;
    const one = recorder((command) => {
      if (command[1] === "bootout") {
        held = false;
        alive = false;
        return {};
      }
      if (command[0] === "kill") {
        if (command[1] === "-KILL") alive = false;
        return { code: alive ? 0 : 1 };
      }
      if (command[1] === "print") {
        // Held and not running is launchd about to start it again, which is
        // what a `stop` that only signalled would have left behind.
        if (!held) return { code: 113 };
        if (!alive) alive = true;
        return { stdout: `\tstate = running\n\tpid = ${String(pid)}\n` };
      }
      return {};
    });
    return { ...one, running: () => alive };
  }

  test("stop boots the unit out, stays until the pid is gone, and kills one that will not go", async () => {
    const at = host();
    // Booted out and not signalled: a signalled supervisor is one `KeepAlive`
    // starts again, and what was asked for is one that stays stopped. The file
    // stays where it is — taking that away as well is `unregister`.
    const leaving = new LaunchdService(at.env, LAUNCHD_LABEL, 200);
    laid(leaving);
    const launchd = keepingAlive();
    const state = await leaving.stop(launchd.run);
    expect(state).toMatchObject({ registered: true, running: false });
    expect(state.pid).toBeUndefined();
    expect(existsSync(leaving.unitFile)).toBe(true);
    expect(launchd.commands.map((command) => command[1])).toContain("bootout");
    expect(launchd.commands.some((command) => command[1] === "kill")).toBe(false);
    expect(launchd.running()).toBe(false);

    // One wedged in its own shutdown: launchd has let the label go and says
    // nothing more about the process, so what is waited on is the pid itself,
    // and the deadline is followed by a kill of that pid and not of a label.
    const wedged = new LaunchdService(at.env, LAUNCHD_LABEL, 200);
    laid(wedged);
    let alive = true;
    const stuck = recorder((command) => {
      if (command[0] === "kill") {
        if (command[1] === "-KILL") alive = false;
        return { code: alive ? 0 : 1 };
      }
      if (command[1] === "print") return alive ? { stdout: "\tpid = 4242\n" } : { code: 113 };
      return {};
    });
    const started = Date.now();
    expect(await wedged.stop(stuck.run)).toMatchObject({ running: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(stuck.commands).toContainEqual(["kill", "-KILL", "4242"]);
    expect(alive).toBe(false);
  });
});

describe("systemd", () => {
  test("register writes a user unit and enables it; unregister disables and removes it", async () => {
    const at = host();
    const service = serviceFor(at.env, "linux");
    const systemctl = recorder();

    await service.register(systemctl.run);
    expect(service.unitFile).toEndWith(`systemd/user/${SYSTEMD_UNIT}`);
    const unit = readFileSync(service.unitFile, "utf8");
    expect(unit).toContain("daemon supervise");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain(`Environment=XDG_CONFIG_HOME=${at.env["XDG_CONFIG_HOME"]}`);
    expect(systemctl.commands.slice(1, 3)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
    ]);

    const after = recorder();
    expect(await service.unregister(after.run)).toEqual({ unregistered: true });
    expect(existsSync(service.unitFile)).toBe(false);
    expect(after.commands[0]).toEqual(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
  });

  test("status is the pid only while the unit is active", async () => {
    const at = host();
    const service = serviceFor(at.env, "linux");
    await service.register(recorder().run);

    const active = recorder(() => ({
      stdout: "MainPID=771\nActiveState=active\nLoadState=loaded\nExecMainStatus=0\n",
    }));
    expect(await service.state(active.run)).toEqual({
      registered: true,
      running: true,
      pid: 771,
      program: { path: expect.any(String), durable: true, exists: true },
      service: { state: "active", loaded: true, running: true, pid: 771, last_exit: 0 },
    });

    const dead = recorder(() => ({
      stdout: "MainPID=0\nActiveState=failed\nLoadState=loaded\nExecMainStatus=2\n",
    }));
    expect(await service.state(dead.run)).toEqual({
      registered: true,
      running: false,
      program: { path: expect.any(String), durable: true, exists: true },
      service: { state: "failed", loaded: true, running: false, pid: null, last_exit: 2 },
    });
  });
});

describe("where the supervisor's own output is read from", () => {
  test("launchd is told a path, so there is a file to tail", async () => {
    const at = host();
    const service = serviceFor(at.env, "darwin");
    await service.register(recorder().run);
    const source = service.logSource();
    expect(source).toMatchObject({ kind: "file" });
    // The plist names the same file the reader opens: one path, decided once.
    const file = (source as { file: string }).file;
    expect(file).toBe(serviceLogFile(at.env));
    expect(readFileSync(service.unitFile, "utf8")).toContain(
      `<key>StandardOutPath</key><string>${file}</string>`,
    );
  });

  test("systemd hands its output to the journal, so the log is asked for", () => {
    const source = serviceFor(host().env, "linux").logSource();
    expect(source).toMatchObject({ kind: "command" });
    const asked = source as { show: string[]; follow: string[] };
    expect(asked.show).toEqual(["journalctl", "--user", "-u", SYSTEMD_UNIT, "--no-pager"]);
    expect(asked.follow).toEqual(["journalctl", "--user", "-u", SYSTEMD_UNIT, "-f"]);
  });
});

describe("a host with neither", () => {
  test("there is nothing to register with, and it says so rather than writing a file", () => {
    expect(() => serviceFor(host().env, "win32")).toThrow("win32");
  });
});

describe("the path a unit is told to run", () => {
  test("a ccmsg on PATH that leads back here is preferred over the runtime's own path", () => {
    const at = host();
    const bin = join(at.root, "bin");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "ccmsg");
    // What an installed ccmsg is on a machine that runs it from a checkout: a
    // couple of lines naming the script, which is what makes it this ccmsg
    // rather than another one.
    writeFileSync(wrapper, `#!/bin/sh\nexec bun ${ENTRY} "$@"\n`);
    chmodSync(wrapper, 0o755);

    const program = supervisorProgram({ PATH: bin });
    expect(program).toEqual({ command: [wrapper, "daemon", "supervise"], durable: true });
    // The wrapper supplies the script, so the unit does not name it twice.
    expect(program.command).not.toContain(ENTRY);
  });

  test("with nothing on PATH the process's own path is used, and a versioned one says so", () => {
    const program = supervisorProgram({ PATH: "" });
    expect(program.command[0]).toBe(process.execPath);
    expect(program.durable).toBe(durable(process.execPath));
  });

  test("a path through a version's own directory is not one to write down", () => {
    expect(durable("/nix/store/47hb-bun-1.3.13/bin/bun")).toBe(false);
    expect(durable("/opt/homebrew/Cellar/bun/1.3.13/bin/bun")).toBe(false);
    expect(durable("/opt/homebrew/bin/bun")).toBe(true);
  });

  test("status says when the program the unit names is no longer there", async () => {
    const at = host();
    const service = serviceFor(at.env, "darwin");
    await service.register(recorder().run);

    const named = registeredProgram(service.unitFile, "launchd");
    expect(named).toEqual({
      path: supervisorProgram().command[0] as string,
      durable: true,
      exists: true,
    });

    // A runtime upgrade takes the directory the unit names away. Nothing else
    // about the registration changes, which is why the missing file is the
    // only thing that can say so.
    writeFileSync(
      service.unitFile,
      readFileSync(service.unitFile, "utf8").replace(named?.path as string, join(at.root, "gone")),
    );
    expect(registeredProgram(service.unitFile, "launchd")).toEqual({
      path: join(at.root, "gone"),
      durable: true,
      exists: false,
    });
  });
});
