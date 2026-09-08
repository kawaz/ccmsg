import type { LauncherRunResult } from "@ccmsg/protocol";
import type { Launch } from "./launcher.ts";

/** How long a command stopped for outliving its allowance is given to leave
 * before it is killed outright. */
const FORCE_KILL_MS = 500;

/** How long the pipes are read after the command itself has exited.
 *
 * A launch that detaches something — which is what starting a session in a
 * terminal is — leaves that grandchild holding the write end, so end-of-file
 * may never arrive. Without a bound the reply would wait for the session to
 * finish. On an ordinary exit every descriptor closes at once and this costs
 * nothing. */
const DRAIN_MS = 500;

/** Start one assembled launch and answer with what it did.
 *
 * Both pipes are read from the moment the command starts, so output larger than
 * a pipe buffer cannot stop the command from finishing. */
export async function spawnLaunch(launch: Launch): Promise<LauncherRunResult> {
  const child = Bun.spawn([...launch.argv], {
    cwd: launch.cwd,
    env: launch.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    timedOut = true;
    child.kill("SIGTERM");
    force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, FORCE_KILL_MS);
  }, launch.timeoutMs);

  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  try {
    const code = await child.exited;
    const [out, err] = await Promise.all([stdout(DRAIN_MS), stderr(DRAIN_MS)]);
    return {
      stdout: out,
      stderr: err,
      // A signal leaves no code to state, so the field is absent rather than
      // carrying a number that means something else.
      ...(child.signalCode === null ? { exit_code: code } : {}),
      timed_out: timedOut,
    };
  } finally {
    clearTimeout(deadline);
    if (force !== undefined) clearTimeout(force);
  }
}

/** Read a pipe as it arrives, and answer with what got there within the grace.
 *
 * Not `Response.text()`: that resolves only at end-of-file, which is the one
 * thing a detached grandchild can postpone forever. */
function collect(stream: ReadableStream<Uint8Array>): (graceMs: number) => Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) chunks.push(value);
    }
  })();
  return async (graceMs) => {
    await Promise.race([
      drained.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
    await reader.cancel().catch(() => {});
    return Buffer.concat(chunks).toString("utf8");
  };
}
