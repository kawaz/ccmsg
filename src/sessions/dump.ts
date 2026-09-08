import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstanceId, SessionDumpWriteArgs, SessionDumpWriteResult } from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import { readRecord, type TranscriptFiles, type TranscriptRecord } from "../transcript/index.ts";

/** Where dumps land: one directory under this instance's own state, named
 * after the config home it answers for like every other per-instance path
 * (§8.1). The caller never supplies a path, so there is none to contain. */
export const DUMPS = "dumps";

export interface DumpDeps {
  readonly self: InstanceId;
  readonly stateDir: string;
  readonly files: TranscriptFiles;
}

/** Write a session's dump and answer with where it went.
 *
 * What this adds over reading the transcript is a durable artifact whose path
 * can be handed to a successor session, rather than a payload that would
 * travel out through a client and back in again. */
export function dumpWrite(args: SessionDumpWriteArgs, deps: DumpDeps): SessionDumpWriteResult {
  if (args.since_at !== undefined && args.since_uuid !== undefined) {
    throw new OpError("invalid_args", "a lower bound is a time or a record, not both");
  }
  if (args.until_at !== undefined && args.until_uuid !== undefined) {
    throw new OpError("invalid_args", "an upper bound is a time or a record, not both");
  }
  const file = deps.files.session(args.sid);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new OpError("not_found", `the transcript of ${args.sid} could not be read`);
  }
  const entries = collect(text, args);
  const document = {
    sid: args.sid,
    instance: deps.self,
    source: file,
    generated_at: Date.now(),
    entries,
  };
  const dir = join(deps.stateDir, DUMPS);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${args.sid}-${document.generated_at}.json`);
  const body = `${JSON.stringify(document, undefined, 2)}\n`;
  writeFileSync(path, body);
  return {
    path,
    instance: deps.self,
    entries: entries.length,
    bytes: Buffer.byteLength(body),
  };
}

/** One record of a dump: what was said, by whom, when.
 *
 * The fields are the record's own, taken from the type that reads a transcript
 * line rather than restated here — a dump reports what was read, and a second
 * spelling of those fields would be a second interpretation of the file. */
type DumpEntry = Pick<TranscriptRecord, "uuid" | "said_at" | "said_by" | "text" | "thinking">;

/** The records within the bounds, in the order the transcript holds them.
 *
 * A record bound cuts at that record's position rather than at its clock, so
 * records sharing an instant stay on their own side of the cut — which is the
 * whole reason the contract offers both kinds of bound. */
function collect(text: string, args: SessionDumpWriteArgs): DumpEntry[] {
  const entries: DumpEntry[] = [];
  // A lower bound by record starts the dump closed: it opens at the record it
  // names, which is included.
  let open = args.since_uuid === undefined;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const record = readRecord(line);
    if (record === undefined) continue;
    if (!open) {
      if (record.uuid !== args.since_uuid) continue;
      open = true;
    }
    if (args.since_at !== undefined && (record.said_at ?? 0) < args.since_at) continue;
    if (args.until_at !== undefined && (record.said_at ?? 0) > args.until_at) break;
    // The machinery of in-process agents: their turns interleave into the
    // session's own file, and a successor resuming the session is resuming the
    // session rather than them.
    if (args.no_agent === true && record.sidechain) {
      if (record.uuid !== undefined && record.uuid === args.until_uuid) break;
      continue;
    }
    entries.push({
      ...(record.uuid === undefined ? {} : { uuid: record.uuid }),
      ...(record.said_at === undefined ? {} : { said_at: record.said_at }),
      ...(record.said_by === undefined ? {} : { said_by: record.said_by }),
      ...(record.text === undefined ? {} : { text: record.text }),
      ...(args.no_thinking === true || record.thinking === undefined
        ? {}
        : { thinking: record.thinking }),
    });
    // An upper bound by record is inclusive, so the cut is after it.
    if (record.uuid !== undefined && record.uuid === args.until_uuid) break;
  }
  return entries;
}
