import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  LAUNCHD_LABEL,
  type Run,
  type RunResult,
  serviceFor,
  serviceLogFile,
  SYSTEMD_UNIT,
} from "../src/service/index.ts";
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

describe("launchd", () => {
  test("register writes the agent and hands it to launchd; unregister takes both back", async () => {
    const at = host();
    const service = serviceFor(at.env, "darwin");
    const launchctl = recorder();

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
    expect(launchctl.commands[0]?.slice(0, 2)).toEqual(["launchctl", "bootstrap"]);

    const gone = await service.unregister(launchctl.run);
    expect(gone).toEqual({ unregistered: true });
    expect(existsSync(service.unitFile)).toBe(false);
    expect(launchctl.commands.at(-1)?.slice(0, 2)).toEqual(["launchctl", "bootout"]);
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
    expect(systemctl.commands.slice(0, 2)).toEqual([
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
      service: { state: "active", loaded: true, running: true, pid: 771, last_exit: 0 },
    });

    const dead = recorder(() => ({
      stdout: "MainPID=0\nActiveState=failed\nLoadState=loaded\nExecMainStatus=2\n",
    }));
    expect(await service.state(dead.run)).toEqual({
      registered: true,
      running: false,
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
