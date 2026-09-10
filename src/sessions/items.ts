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
  const { items } = select(within(classify(located(text)), args), keep);
  const page = paged(items, args.limit);
  return {
    items: page.items,
    ...(page.next === undefined ? {} : { next: page.next }),
    ...(keep.keeps(IDS) ? { ids: ledger(page.items) } : {}),
  };
}

/** As much of the range as one answer carries, and where the next one starts.
 *
 * Two bounds, because either alone leaves a case unanswered: a count cannot
 * keep a page of long briefs inside what a connection should carry, and bytes
 * alone would answer with a number of items that varied with what was said in
 * them. Whichever is reached first ends the page, and the first item left out
 * is named so the caller resumes exactly where this stopped. */
function paged(
  items: readonly Item[],
  limit: number | undefined,
): { items: Item[]; next?: string } {
  const most = Math.min(limit ?? ITEMS_LIMIT, ITEMS_LIMIT);
  const kept: Item[] = [];
  let held = 0;
  for (const item of items) {
    // A first item larger than the whole budget is still answered: a page of
    // nothing would leave the caller resuming at the item it just failed to
    // get, forever.
    if (kept.length > 0 && (kept.length >= most || held >= READ_LIMIT)) {
      return { items: kept, next: item.id };
    }
    kept.push(item);
    held += JSON.stringify(item).length;
  }
  return { items: kept };
}
