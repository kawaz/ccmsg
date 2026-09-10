import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DumpPreset,
  InstanceId,
  SessionDumpFile,
  SessionDumpWriteArgs,
  SessionDumpWriteResult,
} from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import {
  bounded,
  classify,
  ledger,
  located,
  select,
  selection,
  within,
} from "../transcript/items/index.ts";
import type { TranscriptFiles } from "../transcript/index.ts";

/** Where dumps land: one directory under this instance's own state, named
 * after the config home it answers for like every other per-instance path
 * (§8.1). The caller never supplies a path, so there is none to contain. */
export const DUMPS = "dumps";

/** What a dump file is called. Two extensions rather than one so that a reader
 * knows both that it is JSON and that it is JSON of a shape the contract
 * states — the file travels by its path, outliving the request that made it,
 * and is opened by whoever was handed that path. */
export const DUMP_SUFFIX = ".dump.json";

export interface DumpDeps {
  readonly self: InstanceId;
  readonly stateDir: string;
  readonly files: TranscriptFiles;
  /** The selections this instance is configured with, which is what a `preset`
   * name and an `@name` inside a selection are resolved against. */
  readonly presets: readonly DumpPreset[];
}

/** Write a session's dump and answer with where it went.
 *
 * What this adds over reading the transcript is a durable artifact whose path
 * can be handed to a successor session, rather than a payload that would
 * travel out through a client and back in again.
 *
 * The subject is the session, or one agent below it when the request names
 * one. Every item type is read from wherever the subject stands — an agent's
 * `message:user:in` is the brief its parent gave it — so one selection carries
 * unchanged down a chain of agents, which is what makes the ledger's agent ids
 * a way to descend rather than just a list. */
export function dumpWrite(args: SessionDumpWriteArgs, deps: DumpDeps): SessionDumpWriteResult {
  bounded(args);
  const preset = presetFor(args.preset, deps.presets);
  const file = deps.files.locate(
    args.sid,
    args.agent_id === undefined ? {} : { agent_id: args.agent_id },
  );
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new OpError("not_found", `the transcript of ${args.sid} could not be read`);
  }
  // The whole file is classified before the range is applied, so a result
  // inside the range still names the call that fell before it. Cutting first
  // would leave `parent_item` pointing at something the reader never saw.
  const keep = selection(
    {
      ...(args.types === undefined ? {} : { types: args.types }),
      ...(preset === undefined ? {} : { preset }),
      ...(args.no_thinking === undefined ? {} : { no_thinking: args.no_thinking }),
      ...(args.no_agent === undefined ? {} : { no_agent: args.no_agent }),
    },
    deps.presets,
  );
  const { items, entries } = select(within(classify(located(text)), args), keep);
  const ids = ledger(items);
  const written_at = Date.now();
  // The file repeats what it was asked for. A dump outlives the request that
  // made it and is read by whoever was handed the path, so it has to say on
  // its own what it is a dump of and what was left out — which is why the
  // selection is written as applied, with the presets already expanded.
  const document: SessionDumpFile = {
    sid: args.sid,
    ...(args.agent_id === undefined ? {} : { agent_id: args.agent_id }),
    written_at,
    types: [...keep.elements],
    items,
    ids,
  };
  const dir = join(deps.stateDir, DUMPS);
  mkdirSync(dir, { recursive: true });
  const named = args.agent_id === undefined ? args.sid : `${args.sid}-agent-${args.agent_id}`;
  const path = join(dir, `${named}-${written_at}${DUMP_SUFFIX}`);
  const body = `${JSON.stringify(document, undefined, 2)}\n`;
  writeFileSync(path, body);
  return { path, instance: deps.self, entries, ids, bytes: Buffer.byteLength(body) };
}

/** The named selection a request asked for.
 *
 * A name this instance does not have is refused rather than ignored: a dump
 * silently wider than what was asked for is the failure a selection exists to
 * prevent. */
function presetFor(
  name: string | undefined,
  presets: readonly DumpPreset[],
): DumpPreset | undefined {
  if (name === undefined) return undefined;
  const found = presets.find((one) => one.name === name);
  if (found === undefined) throw new OpError("invalid_args", `no preset is configured as ${name}`);
  return found;
}
