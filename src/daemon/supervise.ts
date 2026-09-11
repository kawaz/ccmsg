import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { type Env, resolveSupervisorSocket } from "../instance/paths.ts";
import { CommandError, type SuperviseRequest } from "./link.ts";
import {
  awaitGone,
  awaitSocket,
  type Child,
  configHome,
  harnessFor,
  prepareFor,
  registered,
  rowFor,
  type SpawnInstance,
  spawnInstance,
  START_TIMEOUT_MS,
  type StatusRow,
  status as statusOf,
  stop as askToStop,
  type Target,
  targetFor,
} from "./registry.ts";

/** How long a restart waits, and how a run stops counting as a failure.
 *
 * The values are chosen rather than derived, so here is what each one is for:
 *
 * - `minMs` is the first wait. An instance that exits because its predecessor
 *   still holds the lock needs only the moment that takes, so the first retry
 *   is short enough to be invisible.
 * - `maxMs` bounds a spin. The failure this is really for is a config the
 *   instance refuses to start with (DV-Q9): it fails in milliseconds and will
 *   fail again identically until somebody edits the file, so the cap is the
 *   rate at which the supervisor is willing to say so in its log while waiting
 *   for that edit.
 * - `steadyMs` is how long a child has to stay up before its next exit is read
 *   as a new failure rather than a continuing one. It is longer than `maxMs`
 *   because a child that dies at the cap and is restarted must not have its
 *   own restart counted as recovery. */
export interface Backoff {
  readonly minMs: number;
  readonly maxMs: number;
  readonly steadyMs: number;
}

export const BACKOFF: Backoff = { minMs: 500, maxMs: 30_000, steadyMs: 60_000 };

/** The time each cooperative stop stage gets before the supervisor escalates. */
export const STOP_TIMEOUT_MS = 10_000;

export interface SuperviseOptions {
  readonly env?: Env;
  readonly spawn?: SpawnInstance;
  readonly backoff?: Backoff;
  /** Where the supervisor says what it did. */
  readonly log?: (line: Record<string, unknown>) => void;
  /** How long a start waits for the child to be serving before it is reported
   * as having failed. */
  readonly startTimeoutMs?: number;
  /** How long each graceful and SIGTERM stop stage may hold shutdown. */
  readonly stopTimeoutMs?: number;
}

/** One config home the supervisor looks after, and how it is doing.
 *
 * `wanted` is what separates "the child is gone and should come back" from "the
 * child is gone because it was told to go": a restart loop with no such flag
 * cannot be asked to stop one instance without stopping the supervisor. */
class Supervised {
  child: Child | undefined;
  wanted = true;
  loop: Promise<void> = Promise.resolve();
  readonly #waiting: ((child: Child) => void)[] = [];
  constructor(readonly target: Target) {}

  /** The restart loop spawns on its own turn of the event loop, so a caller
   * that just asked for a start has no child to watch yet. This is that child,
   * whenever it arrives: without it, "has it failed?" is asked of a handle that
   * is not there and answered as though it had. */
  took(child: Child): void {
    this.child = child;
    for (const waiting of this.#waiting.splice(0)) waiting(child);
  }

  next(): Promise<Child> {
    const child = this.child;
    if (child !== undefined) return Promise.resolve(child);
    return new Promise((resolve) => this.#waiting.push(resolve));
  }
}

/** The foreground supervisor: the instances the shared file lists, kept up, and
 * a socket over which they are asked about.
 *
 * The list is read once, when this starts (DV-Q8). What changes it afterwards
 * is a request — `daemon add` and `daemon remove` tell the supervisor as well
 * as the file — rather than the file being re-read, so the supervisor's idea of
 * which instances there are and the file's cannot silently disagree about
 * anything nobody said out loud. */
export class Supervisor {
  readonly #env: Env;
  readonly #spawn: SpawnInstance;
  readonly #backoff: Backoff;
  readonly #log: (line: Record<string, unknown>) => void;
  readonly #startTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #units = new Map<string, Supervised>();
  readonly #waits = new Set<() => void>();
  #listener: ReturnType<typeof Bun.listen> | undefined;
  #leaving = false;
  #left: (() => void) | undefined;
  #ran: Promise<void> | undefined;

  constructor(options: SuperviseOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#spawn = options.spawn ?? spawnInstance;
    this.#backoff = options.backoff ?? BACKOFF;
    this.#startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.#log = options.log ?? ((line) => process.stderr.write(`${JSON.stringify(line)}\n`));
    for (const target of registered(this.#env)) this.#units.set(target.dir, new Supervised(target));
  }

  /** The config homes this supervisor is looking after right now. */
  get targets(): readonly Target[] {
    return [...this.#units.values()].map((unit) => unit.target);
  }

  get socketPath(): string {
    return resolveSupervisorSocket(this.#env);
  }

  /** Run until asked to leave: the socket answering, and one restart loop per
   * config home. One instance failing is not a reason to disturb the others. */
  run(): Promise<void> {
    this.#ran ??= this.#serve();
    return this.#ran;
  }

  async #serve(): Promise<void> {
    await this.#listen();
    for (const unit of this.#units.values()) this.#keep(unit);
    // What ends the run is being asked to, not the children ending: a
    // supervisor with nothing left to look after is still the process a command
    // connects to.
    await new Promise<void>((resolve) => {
      this.#left = resolve;
    });
    await Promise.all([...this.#units.values()].map((unit) => unit.loop));
  }

  /** The control socket: this host's, and this uid's.
   *
   * 0600 because everything reachable through it is a process this uid runs,
   * and A4 puts the boundary at the uid — the mode is what says so on a
   * filesystem where the directory above may not.
   *
   * A path left by a run that was killed is removed first: a socket file with
   * nobody behind it refuses connections, so binding over it is taking an
   * address nothing holds rather than one somebody is using. Two supervisors
   * racing for it is not a case this settles, because the only starter is an
   * init system that runs one. */
  async #listen(): Promise<void> {
    const path = this.socketPath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      unlinkSync(path);
    } catch {
      // Not there, which is the state this wanted.
    }
    const handle = (frame: Record<string, unknown>): Promise<unknown> =>
      this.handle(frame as unknown as SuperviseRequest);
    this.#listener = Bun.listen<{ buffer: string }>({
      unix: path,
      socket: {
        open(socket) {
          socket.data = { buffer: "" };
        },
        data(socket, chunk) {
          socket.data.buffer += new TextDecoder().decode(chunk);
          let at: number;
          while ((at = socket.data.buffer.indexOf("\n")) >= 0) {
            const line = socket.data.buffer.slice(0, at);
            socket.data.buffer = socket.data.buffer.slice(at + 1);
            if (line.trim() === "") continue;
            void answer(socket, line, handle);
          }
        },
      },
    });
    chmodSync(path, 0o600);
    this.#log({ event: "listening", socket: path });
    await Promise.resolve();
  }

  /** One request, and what it answers with. Public so a test can put a request
   * without a socket between it and the answer. */
  async handle(request: SuperviseRequest): Promise<unknown> {
    switch (request.op) {
      case "supervise_start":
        return await this.#over(request, (unit) => this.startOne(unit.target.dir));
      case "supervise_stop":
        return await this.#over(request, (unit) => this.stopOne(unit.target.dir));
      case "supervise_restart":
        return await this.#over(request, (unit) => this.restartOne(unit.target.dir));
      case "supervise_status":
        return await this.#over(request, (unit) => statusOf(unit.target));
      case "supervise_add":
        return await this.addOne(this.#named(request));
      case "supervise_remove":
        return this.removeOne(this.#named(request));
      default:
        throw new CommandError("unknown_op", `知らない要求です: ${String(request.op)}`);
    }
  }

  /** One config home, or every one this supervisor looks after.
   *
   * Over `--all`, one config home refusing is reported beside the others rather
   * than in place of them: the answer is a row per instance, and a stop that
   * failed at the second of five would otherwise leave the caller unable to
   * tell which three it reached. */
  async #over<T>(
    request: SuperviseRequest,
    op: (unit: Supervised) => Promise<T>,
  ): Promise<T | (T | { dir: string; error: { code: string; msg: string } })[]> {
    if (request.all !== true) {
      const unit = this.#units.get(this.#named(request));
      if (unit === undefined) {
        throw new CommandError("not_found", `${this.#named(request)} は登録されていません`);
      }
      return await op(unit);
    }
    const answers: (T | { dir: string; error: { code: string; msg: string } })[] = [];
    // Taken as a list first: each step below waits, and a request arriving in
    // between may add or remove one — what `--all` answers about is the set as
    // it stood when it was asked.
    const units = Array.from(this.#units.values());
    for (const unit of units) {
      try {
        answers.push(await op(unit));
      } catch (cause) {
        if (!(cause instanceof CommandError)) throw cause;
        answers.push({ dir: unit.target.dir, error: { code: cause.code, msg: cause.message } });
      }
    }
    return answers;
  }

  #named(request: SuperviseRequest): string {
    const dir = request.dir;
    if (dir === undefined) throw new CommandError("invalid_args", "dir か --all が要ります");
    return dir;
  }

  /** Start one child, and answer once it is serving. */
  async startOne(dir: string): Promise<StatusRow> {
    const unit = this.#units.get(dir);
    if (unit === undefined) throw new CommandError("not_found", `${dir} は登録されていません`);
    if (unit.child !== undefined) {
      throw new CommandError(
        "file_exists",
        `${dir} の instance は既に動いています (pid ${String(unit.child.pid)})`,
      );
    }
    unit.wanted = true;
    this.#keep(unit);
    await this.#serving(unit);
    return await statusOf(unit.target);
  }

  /** Stop one child, and leave it stopped.
   *
   * Asked over its own socket rather than signalled, so what runs is the
   * ordered shutdown of §8.5 — the same departure a client sees from an
   * `instance.shutdown`. */
  async stopOne(dir: string): Promise<{ dir: string; stopped: boolean }> {
    const unit = this.#units.get(dir);
    if (unit === undefined) throw new CommandError("not_found", `${dir} は登録されていません`);
    const child = unit.child;
    if (child === undefined) {
      throw new CommandError("instance_unreachable", `${dir} の instance は動いていません`);
    }
    // Said before the request, so the restart loop reads it as a departure it
    // asked for rather than one to recover from.
    unit.wanted = false;
    for (const cancel of new Set(this.#waits)) cancel();
    await this.#stopChild(unit, child);
    await unit.loop;
    return { dir, stopped: true };
  }

  async restartOne(dir: string): Promise<StatusRow> {
    const unit = this.#units.get(dir);
    if (unit === undefined) throw new CommandError("not_found", `${dir} は登録されていません`);
    if (unit.child !== undefined) {
      await this.stopOne(dir);
      await awaitGone(unit.target.paths, this.#startTimeoutMs);
    }
    return await this.startOne(dir);
  }

  /** Look after one more config home, and start it.
   *
   * The file is written by the command before this is asked, so what this adds
   * is the running half: a config home that is on the list and has nothing
   * behind it is the state `add` exists to leave behind only when there is no
   * supervisor to tell. */
  async addOne(dir: string): Promise<StatusRow> {
    const home = configHome(dir, harnessFor(this.#env, dir));
    if (this.#units.has(home)) {
      throw new CommandError("file_exists", `${home} は既に見ています`);
    }
    this.#units.set(home, new Supervised(targetFor(this.#env, home)));
    return await this.startOne(home);
  }

  /** Stop looking after one, without stopping it.
   *
   * The child is left running because a list edit is not a shutdown: a session
   * connected to that instance keeps the instance it is talking to, and
   * `daemon stop` is how one is stopped. What ends is the restarting — when it
   * next goes, nothing brings it back. */
  removeOne(dir: string): { dir: string; removed: boolean } {
    const unit = this.#units.get(dir);
    if (unit === undefined) throw new CommandError("not_found", `${dir} は見ていません`);
    unit.wanted = false;
    this.#units.delete(dir);
    this.#log({ event: "released", dir, pid: unit.child?.pid ?? null });
    return { dir, removed: true };
  }

  /** The restart loop for one config home. Started per unit rather than once,
   * so a request about one instance never waits on another. */
  #keep(unit: Supervised): void {
    unit.loop = unit.loop.then(async () => {
      let wait = this.#backoff.minMs;
      while (unit.wanted && !this.#leaving) {
        const startedAt = Date.now();
        prepareFor(unit.target);
        const child = this.#spawn(unit.target.dir, this.#env);
        unit.took(child);
        this.#log({ event: "started", dir: unit.target.dir, pid: child.pid });
        const code = await child.exited;
        unit.child = undefined;
        if (!unit.wanted || this.#leaving) {
          this.#log({ event: "stopped", dir: unit.target.dir, code });
          return;
        }
        // A child that stayed up is a run that ended, not a start that failed,
        // so the next attempt begins at the short wait again.
        wait = Date.now() - startedAt >= this.#backoff.steadyMs ? this.#backoff.minMs : wait;
        this.#log({ event: "restarting", dir: unit.target.dir, code, in_ms: wait });
        await this.#pause(wait);
        wait = Math.min(wait * 2, this.#backoff.maxMs);
      }
    });
  }

  /** Wait for a freshly started child to be serving, or for it to have failed.
   *
   * The socket is the answer either way: an instance that is up has published
   * it, and one that exited never did. */
  async #serving(unit: Supervised): Promise<void> {
    // The child first, because the loop makes the directories as it spawns and a
    // watch cannot attach to a directory that is not there yet: waiting for the
    // socket before the child exists is waiting on nothing but the deadline.
    const child = await unit.next();
    const gone = child.exited.then(
      (code) => new CommandError("internal_error", `起動に失敗しました (exit ${String(code)})`),
    );
    const outcome = await Promise.race([
      awaitSocket(unit.target.paths, this.#startTimeoutMs).then(() => undefined),
      gone,
    ]);
    if (outcome instanceof CommandError) throw outcome;
    if (!rowFor(unit.target).running) {
      throw new CommandError("internal_error", `${unit.target.dir} の instance が起動しません`);
    }
  }

  /** Wait, unless the supervisor is asked to leave first: a pending restart is
   * not something a shutdown should have to sit through. */
  #pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waits.delete(cancel);
        resolve();
      }, ms);
      const cancel = (): void => {
        clearTimeout(timer);
        this.#waits.delete(cancel);
        resolve();
      };
      this.#waits.add(cancel);
    });
  }

  async #stopChild(unit: Supervised, child: Child): Promise<void> {
    const within = async (work: Promise<unknown>): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#stopTimeoutMs);
      });
      try {
        return await Promise.race([
          work.then(
            () => true,
            () => false,
          ),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    // Each stage is said out loud with how long the one before it took. A child
    // that will not leave is a thing that happens on a machine nobody is
    // watching, and what stage it was at is the whole of what can be known
    // about it afterwards.
    const startedAt = Date.now();
    const say = (stage: string) => {
      this.#log({
        event: "stopping",
        dir: unit.target.dir,
        pid: child.pid,
        stage,
        in_ms: Date.now() - startedAt,
      });
    };

    say("asked");
    if (await within(askToStop(unit.target).then(() => child.exited))) {
      say("exited");
      return;
    }
    say("sigterm");
    child.kill("SIGTERM");
    if (await within(child.exited)) {
      say("exited");
      return;
    }
    say("sigkill");
    child.kill("SIGKILL");
    await child.exited;
    say("exited");
  }

  /** Stop every child, stop restarting them, and give up the socket. */
  async stop(): Promise<void> {
    this.#leaving = true;
    for (const cancel of new Set(this.#waits)) cancel();
    await Promise.all(
      [...this.#units.values()].map(async (unit) => {
        const child = unit.child;
        if (child === undefined) return;
        await this.#stopChild(unit, child);
      }),
    );
    this.#listener?.stop(true);
    this.#listener = undefined;
    this.#left?.();
    await this.#ran;
  }
}

/** Answer one line, in the shape a command reads: the result, or the error. */
async function answer(
  socket: Bun.Socket<{ buffer: string }>,
  line: string,
  handle: (frame: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(line) as Record<string, unknown>;
  } catch {
    socket.write(
      `${JSON.stringify({ ok: false, error: { code: "bad_request", msg: "not valid JSON" } })}\n`,
    );
    return;
  }
  try {
    socket.write(`${JSON.stringify({ ok: true, result: await handle(frame) })}\n`);
  } catch (cause) {
    const error =
      cause instanceof CommandError
        ? { code: cause.code, msg: cause.message }
        : { code: "internal_error", msg: String(cause) };
    socket.write(`${JSON.stringify({ ok: false, error })}\n`);
  }
}
