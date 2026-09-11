import { readFileSync } from "node:fs";
import type {
  DumpPreset,
  TranscriptItemsReadArgs,
  TranscriptItemsReadResult,
} from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import type { TranscriptFiles } from "../transcript/index.ts";
import {
  bounded,
  classify,
  type Item,
  ledger,
  located,
  select,
  selection,
  within,
} from "../transcript/items/index.ts";
import { READ_LIMIT } from "../transcript/read.ts";

/** How many items one read may carry.
 *
 * The count a client draws in one go rather than a bound on the payload: an
 * item is a sentence or a whole brief, so the size of a page is not something
 * a count can state. The bytes below are what actually bounds it, and this is
 * what keeps a page a page. */
export const ITEMS_LIMIT = 500;

/** The selector that asks for the ledger.
 *
 * The ledger is not an item type — an id says how to point at something, not
 * what a line is — so asking for it is asking for a section rather than
 * selecting a family. It is written in the same list because that is where a
 * caller says what it wants out of a transcript. */
const IDS = "ids";

export interface ItemsReadDeps {
  readonly files: TranscriptFiles;
  /** The named selections this instance is configured with, which is what an
   * `@name` inside a selection is resolved against. */
  readonly presets: readonly DumpPreset[];
}

/** A slice of a transcript as the items it was read into.
 *
 * The raw read answers with the harness's own lines, which leaves the caller
 * holding a private format; this answers with what those lines were classified
 * as. Both stay: a client works in items and fetches the record behind one by
 * the `source` that item carries.
 *
 * The whole file is classified before the range is applied, the way a dump's
 * is. That is what makes a link answerable: a result inside the range whose
 * call fell before it still names the call, and the caller can ask for the
 * call by the id it was given. */
export function itemsRead(
  args: TranscriptItemsReadArgs,
  deps: ItemsReadDeps,
): TranscriptItemsReadResult {
  bounded(args);
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
  const keep = selection(args.types === undefined ? {} : { types: args.types }, deps.presets);
  const { items } = select(within(classify(located(text), deps.files.subjectOf(file)), args), keep);
  const page = paged(items, args.limit, backwards(args));
  return {
    items: page.items,
    ...(page.next === undefined ? {} : { next: page.next }),
    ...(page.prev === undefined ? {} : { prev: page.prev }),
    ...(keep.keeps(IDS) ? { ids: ledger(page.items) } : {}),
  };
}

/** Whether the range's end is the part to answer with.
 *
 * A caller that named where to start is reading forward from there; anyone
 * else is looking at the newest of what it asked for, and answering with the
 * oldest of that range would hand it the far side of a transcript it is
 * walking back through. Naming no bound at all is the ordinary first read and
 * answers the tail the same way; a caller that wants the transcript from its
 * beginning says so with `since_at: 0`. */
function backwards(bounds: TranscriptItemsReadArgs): boolean {
  const lower =
    bounds.since_at !== undefined ||
    bounds.since_uuid !== undefined ||
    bounds.since_id !== undefined;
  return !lower;
}

/** As much of the range as one answer carries, and where the next one starts.
 *
 * Two bounds, because either alone leaves a case unanswered: a count cannot
 * keep a page of long briefs inside what a connection should carry, and bytes
 * alone would answer with a number of items that varied with what was said in
 * them. Whichever is reached first ends the page.
 *
 * Which end of the range is kept is the caller's, and the item named back is
 * the one it continues from: reading forward, the first item left out, to be
 * given as `since_id`; reading back, the first item answered, to be given as
 * `until_id`. Either way the answer is oldest first, because that is the order
 * a transcript has. */
function paged(
  items: readonly Item[],
  limit: number | undefined,
  back: boolean,
): { items: Item[]; next?: string; prev?: string } {
  const most = Math.min(limit ?? ITEMS_LIMIT, ITEMS_LIMIT);
  const kept: Item[] = [];
  let held = 0;
  for (let at = 0; at < items.length; at += 1) {
    const item = items[back ? items.length - 1 - at : at];
    if (item === undefined) continue;
    // A first item larger than the whole budget is still answered: a page of
    // nothing would leave the caller resuming at the item it just failed to
    // get, forever.
    if (kept.length > 0 && (kept.length >= most || held >= READ_LIMIT)) {
      if (!back) return { items: kept, next: item.id };
      kept.reverse();
      const first = kept[0];
      return first === undefined ? { items: kept } : { items: kept, prev: first.id };
    }
    kept.push(item);
    held += JSON.stringify(item).length;
  }
  if (back) kept.reverse();
  return { items: kept };
}
