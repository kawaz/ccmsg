import {
  type Capability,
  type DumpPreset,
  type DumpPresetsReadResult,
  type InstanceId,
  type SessionDumpWriteArgs,
  type SessionEnvReadArgs,
  type SessionEnvReadResult,
  type SessionForkOriginReadArgs,
  type SessionForkOriginReadResult,
  type SessionKillArgs,
  type SessionKillResult,
  type SessionForgetArgs,
  type SessionForgetResult,
  type SessionRenameArgs,
  type SessionRenameResult,
  type SessionSearchArgs,
  type Sid,
  TITLE_MAX_CHARS,
  type TranscriptItemsReadArgs,
  type TranscriptItemsReadResult,
  type TranscriptReadArgs,
  type TranscriptReadResult,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../dispatch/index.ts";
import { sees, type Viewer } from "../files/index.ts";
import { readSlice, type TranscriptFiles } from "../transcript/index.ts";
import { dumpWrite } from "./dump.ts";
import { forkOrigin } from "./fork.ts";
import { itemsRead } from "./items.ts";
import type { SessionProcesses } from "./processes.ts";
import { statedTerminalId } from "./runs.ts";
import { search } from "./search.ts";

/** The two capabilities of the session ops, present only where what they rest
 * on is configured.
 *
 * `terminal` rests on a multiplexer this instance can type into, which is a
 * deployment fact: a host without one has no handle a rename could reach.
 * `fork` rests on the operator asking for it, because finding a seam reads
 * whole sibling transcripts and a host holding large ones pays that on every
 * ask. A client is told before it calls rather than refused when it does. */
export function sessionCapabilities(config: {
  terminal_gateway?: string;
  fork_origin: boolean;
}): Capability[] {
  return [
    ...(config.fork_origin ? (["fork"] as const) : []),
    ...(config.terminal_gateway === undefined || config.terminal_gateway === ""
      ? []
      : (["terminal"] as const)),
  ];
}

export interface SessionOpsDeps {
  readonly self: InstanceId;
  /** The one config home this instance answers for (M6). */
  readonly configHome: string;
  readonly stateDir: string;
  readonly files: TranscriptFiles;
  readonly processes: SessionProcesses;
  /** Drop one entry from the list of sessions that were running when this
   * instance last saw them. The sessions domain owns the list; this op only
   * asks it to forget a row. */
  readonly forget: (sid: Sid) => boolean;
  /** The named selections this instance is configured with (DESIGN §2.5). */
  readonly presets: readonly DumpPreset[];
  /** Whether two or more processes are running one session, which is what a
   * dump of it is refused for: a transcript two runs are writing reads as
   * neither of them (DR-0001 §3). */
  readonly duplicated: (sid: Sid) => boolean;
}

/** The ops that observe and operate on sessions.
 *
 * None of them decides who may call it: dispatch has settled that from the
 * attribute table. The one that narrows by role is `transcript.read`, and it
 * narrows through the same `sees` the file ops narrow through — the visible
 * range of a `scope: "role"` op is one rule, in one place, whatever it is
 * a range over. */
export function sessionHandlers(deps: SessionOpsDeps) {
  const viewer = (input: HandlerInput): Viewer => ({ role: input.role, sid: input.identity?.sid });

  return {
    "session.kill": async (input: HandlerInput): Promise<SessionKillResult> => {
      const args = input.args as unknown as SessionKillArgs;
      return await deps.processes.kill(args.sid, args.force === true, args.pid);
    },

    "session.rename": async (input: HandlerInput): Promise<SessionRenameResult> => {
      const args = input.args as unknown as SessionRenameArgs;
      const title = validTitle(args.title);
      const terminal = await deps.processes.terminal(args.sid);
      // The title is typed, so the newline that submits it is a keystroke of
      // its own rather than a character appended to the line: the terminal
      // drains what was typed before the submit reaches it.
      await deps.processes.type(terminal, [`text:/rename ${title}`, "key:Enter"]);
      // The handle is stated with the scheme that says how it is opened, which
      // is what every other statement of a terminal carries (contract,
      // `terminalUrl`); the bare handle is what was typed into.
      return { terminal_id: statedTerminalId(terminal.id), instance: deps.self, title };
    },

    "session.env.read": async (input: HandlerInput): Promise<SessionEnvReadResult> => {
      const args = input.args as unknown as SessionEnvReadArgs;
      const { pid, env } = await deps.processes.environment(args.sid);
      return { pid, instance: deps.self, env };
    },

    "session.search": (input: HandlerInput) =>
      search(input.args as unknown as SessionSearchArgs, {
        self: deps.self,
        configHome: deps.configHome,
        files: deps.files,
      }),

    "session.dump.write": (input: HandlerInput) => {
      const args = input.args as unknown as SessionDumpWriteArgs;
      refuseDuplicated(args.sid, deps.duplicated);
      return dumpWrite(args, {
        self: deps.self,
        stateDir: deps.stateDir,
        files: deps.files,
        presets: deps.presets,
      });
    },

    /** Which selections a dump may be asked for by name.
     *
     * Nothing else states them, so a client without this could only offer a
     * free-text field and let the instance refuse. A preset that references
     * another is answered as written: the expansion, and the refusal of a
     * cycle, happen where the config is read. */
    "dump.presets.read": (): DumpPresetsReadResult => ({ presets: [...deps.presets] }),

    "session.fork.origin.read": async (
      input: HandlerInput,
    ): Promise<SessionForkOriginReadResult> => {
      const args = input.args as unknown as SessionForkOriginReadArgs;
      const origin = await forkOrigin(args.sid, deps.files);
      return origin === undefined ? {} : { origin };
    },

    "session.forget": (input: HandlerInput): SessionForgetResult => {
      const args = input.args as unknown as SessionForgetArgs;
      // An unknown session is not an error: two clients pressing the same
      // button is the ordinary case, and the caller's goal holds either way.
      return { removed: deps.forget(args.sid) };
    },

    "transcript.read": async (input: HandlerInput): Promise<TranscriptReadResult> => {
      const args = input.args as unknown as TranscriptReadArgs;
      if (!sees(args.sid, viewer(input))) {
        // The role sets the visible range, not the permission (DESIGN §2.2): outside
        // it there is no transcript to speak of, which is the one code this op
        // declares. A refusal that named the session would answer a question
        // the caller was not entitled to ask.
        throw new OpError("not_found", `no transcript is known for ${args.sid}`);
      }
      const file = await deps.files.locate(args.sid, args);
      return await readSlice(args.sid, file, args.before, args.max_bytes);
    },

    /** The same transcript, as the items it was read into.
     *
     * The role narrows it the way it narrows the raw read: what a role may see
     * is one rule whatever is being read, and a caller that cannot see a
     * session cannot see it in either vocabulary. */
    "transcript.items.read": async (input: HandlerInput): Promise<TranscriptItemsReadResult> => {
      const args = input.args as unknown as TranscriptItemsReadArgs;
      if (!sees(args.sid, viewer(input))) {
        throw new OpError("not_found", `no transcript is known for ${args.sid}`);
      }
      return await itemsRead(args, { files: deps.files, presets: deps.presets });
    },
  };
}

/** Refuse a call that names a session two or more processes are running.
 *
 * Nothing is held back for later: what the caller wanted is still theirs, and a
 * person decides which run to end before anything here resumes (contract,
 * `session_duplicated`). */
export function refuseDuplicated(sid: Sid, duplicated: (sid: Sid) => boolean): void {
  if (!duplicated(sid)) return;
  throw new OpError(
    "session_duplicated",
    `${sid} is being run by more than one process, so what this would act on is not settled`,
  );
}

/** A title fit to be typed.
 *
 * A control character is refused rather than stripped: the value reaches the
 * terminal as keystrokes, where a newline submits a half-written command and
 * the rest are control sequences — and renaming a session to something the
 * caller did not write is worse than an error they can act on. */
function validTitle(raw: string): string {
  const title = raw.trim();
  if (title === "") throw new OpError("invalid_args", "a title is not only whitespace");
  if (title.length > TITLE_MAX_CHARS) {
    throw new OpError("invalid_args", `a title is at most ${TITLE_MAX_CHARS} characters`);
  }
  for (let at = 0; at < title.length; at++) {
    // Code units are enough: every surrogate half is above this range, so no
    // astral character can be read as a control character.
    const code = title.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) {
      throw new OpError("invalid_args", "a title carries no control characters");
    }
  }
  return title;
}
