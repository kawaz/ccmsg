import {
  type Capability,
  type DumpPreset,
  type DumpPresetsReadResult,
  type InstanceId,
  type SessionDumpWriteArgs,
  type SessionEnvReadArgs,
  type SessionEnvReadResult,
  type SessionForkOriginArgs,
  type SessionForkOriginResult,
  type SessionKillArgs,
  type SessionKillResult,
  type SessionLastLiveRemoveArgs,
  type SessionLastLiveRemoveResult,
  type SessionRenameArgs,
  type SessionRenameResult,
  type SessionSearchArgs,
  type Sid,
  TITLE_MAX_CHARS,
  type TranscriptReadArgs,
  type TranscriptReadResult,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../dispatch/index.ts";
import { sees, type Viewer } from "../files/index.ts";
import { readSlice, type TranscriptFiles } from "../transcript/index.ts";
import { dumpWrite } from "./dump.ts";
import { forkOrigin } from "./fork.ts";
import type { SessionProcesses } from "./processes.ts";
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
  /** The named selections this instance is configured with (§3.6). */
  readonly presets: readonly DumpPreset[];
}

/** The ops that observe and operate on sessions.
 *
 * None of them decides who may call it: dispatch has settled that from the
 * attribute table. The one that narrows by role is `transcript_read`, and it
 * narrows through the same `sees` the file ops narrow through — the visible
 * range of a `scope: "role"` op is one rule, in one place, whatever it is
 * a range over. */
export function sessionHandlers(deps: SessionOpsDeps) {
  const viewer = (input: HandlerInput): Viewer => ({ role: input.role, sid: input.identity?.sid });

  return {
    session_kill: async (input: HandlerInput): Promise<SessionKillResult> => {
      const args = input.args as unknown as SessionKillArgs;
      return await deps.processes.kill(args.sid, args.force === true);
    },

    session_rename: async (input: HandlerInput): Promise<SessionRenameResult> => {
      const args = input.args as unknown as SessionRenameArgs;
      const title = validTitle(args.title);
      const terminal = await deps.processes.terminal(args.sid);
      // The title is typed, so the newline that submits it is a keystroke of
      // its own rather than a character appended to the line: the terminal
      // drains what was typed before the submit reaches it.
      await deps.processes.type(terminal, [`text:/rename ${title}`, "key:Enter"]);
      return { terminal_id: terminal.id, instance: deps.self, title };
    },

    session_env_read: async (input: HandlerInput): Promise<SessionEnvReadResult> => {
      const args = input.args as unknown as SessionEnvReadArgs;
      const { pid, env } = await deps.processes.environment(args.sid);
      return { pid, instance: deps.self, env };
    },

    session_search: (input: HandlerInput) =>
      search(input.args as unknown as SessionSearchArgs, {
        self: deps.self,
        configHome: deps.configHome,
        files: deps.files,
      }),

    session_dump_write: (input: HandlerInput) =>
      dumpWrite(input.args as unknown as SessionDumpWriteArgs, {
        self: deps.self,
        stateDir: deps.stateDir,
        files: deps.files,
        presets: deps.presets,
      }),

    /** Which selections a dump may be asked for by name.
     *
     * Nothing else states them, so a client without this could only offer a
     * free-text field and let the instance refuse. A preset that references
     * another is answered as written: the expansion, and the refusal of a
     * cycle, happen where the config is read. */
    dump_presets_read: (): DumpPresetsReadResult => ({ presets: [...deps.presets] }),

    session_fork_origin: (input: HandlerInput): SessionForkOriginResult => {
      const args = input.args as unknown as SessionForkOriginArgs;
      const origin = forkOrigin(args.sid, deps.files);
      return origin === undefined ? {} : { origin };
    },

    session_last_live_remove: (input: HandlerInput): SessionLastLiveRemoveResult => {
      const args = input.args as unknown as SessionLastLiveRemoveArgs;
      // An unknown session is not an error: two clients pressing the same
      // button is the ordinary case, and the caller's goal holds either way.
      return { removed: deps.forget(args.sid) };
    },

    transcript_read: (input: HandlerInput): TranscriptReadResult => {
      const args = input.args as unknown as TranscriptReadArgs;
      if (!sees(args.sid, viewer(input))) {
        // The role sets the visible range, not the permission (§3.2): outside
        // it there is no transcript to speak of, which is the one code this op
        // declares. A refusal that named the session would answer a question
        // the caller was not entitled to ask.
        throw new OpError("not_found", `no transcript is known for ${args.sid}`);
      }
      const file = deps.files.locate(args.sid, args);
      return readSlice(args.sid, file, args.before, args.max_bytes);
    },
  };
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
