import type { DumpPreset } from "@ccmsg/protocol";
import type { Item } from "./item.ts";

/** Which of a transcript's items a dump keeps.
 *
 * A selection is a list read left to right, where each element is a type name,
 * a prefix of one, either of those negated with `-`, or `@name` standing for a
 * preset expanded in place. Order is what makes it usable: a prefix brings a
 * family in and an exclusion after it takes one member back out, which is the
 * shape a person actually reaches for — every tool but the reads, the whole
 * conversation but not the thinking.
 *
 * A prefix matches at segment boundaries, so `tool` reaches `tool:Bash` and
 * `message:user` reaches both directions, while `notice` never reaches a type
 * that merely starts with those letters. */

/** The ledger is asked for the way a type is, because that is how a person
 * thinks of it — one more thing the dump may carry — but it is not a type: it
 * is the ids the items already carried, gathered once. Selecting it says to
 * write that section, and nothing about which items are kept. */
export const IDS = "ids";

/** Stands for every type at once, so the default can be written as what it is:
 * all of it, less the attachments. It is spelled with a character no type name
 * may hold, which keeps it out of reach of anything a caller could send — the
 * default is this instance's, not a selection anyone writes. */
const EVERYTHING = "*";

/** What a dump keeps when nobody said. Everything the transcript held except
 * the attachments, which are the harness furnishing a turn rather than
 * anything that happened in it, and which outnumber the rest. */
const DEFAULT_TYPES = [EVERYTHING, "-system:attachment"];

export interface Selection {
  /** Whether an item of this type is kept. */
  readonly keeps: (type: string) => boolean;
  readonly ids: boolean;
}

/** What a dump was asked to keep.
 *
 * `preset` is the ground and `types` is applied over it, so naming both means
 * "that one, with these changes" rather than one silently replacing the other.
 * The two flags say in one word what the selection says in its own vocabulary,
 * and are applied last for that reason: whatever brought thinking or an
 * agent's machinery in, saying `no` takes it back out. */
export interface Ask {
  readonly types?: readonly string[];
  readonly preset?: DumpPreset;
  readonly no_thinking?: boolean;
  readonly no_agent?: boolean;
}

const NO_THINKING = ["-thinking"];
const NO_AGENT = ["-message:sub", "-tool:Agent"];

export function selection(ask: Ask, presets: readonly DumpPreset[]): Selection {
  const asked = [...(ask.preset?.opts.types ?? []), ...(ask.types ?? [])];
  const elements = expand(
    [
      ...(asked.length === 0 ? DEFAULT_TYPES : asked),
      ...(ask.no_thinking === true ? NO_THINKING : []),
      ...(ask.no_agent === true ? NO_AGENT : []),
    ],
    presets,
    [],
  );
  const cache = new Map<string, boolean>();
  return {
    keeps: (type) => {
      const known = cache.get(type);
      if (known !== undefined) return known;
      const kept = decide(type, elements);
      cache.set(type, kept);
      return kept;
    },
    ids: decide(IDS, elements),
  };
}

/** Whether one type survives the list, reading it left to right: each element
 * that reaches the type sets the answer, and the last one to reach it wins. */
function decide(type: string, elements: readonly string[]): boolean {
  let kept = false;
  for (const element of elements) {
    const negated = element.startsWith("-");
    const name = negated ? element.slice(1) : element;
    if (reaches(name, type)) kept = !negated;
  }
  return kept;
}

function reaches(name: string, type: string): boolean {
  return name === EVERYTHING || type === name || type.startsWith(`${name}:`);
}

/** A preset named in a selection, put where it was named.
 *
 * Expansion happens here rather than at the leaves so an exclusion written
 * after a preset reaches what the preset brought in. Depth is bounded by the
 * chain being walked: a cycle was refused when the config was read, so a name
 * met twice on one path cannot happen and is a programming error rather than
 * an operator's. */
function expand(
  elements: readonly string[],
  presets: readonly DumpPreset[],
  path: readonly string[],
): string[] {
  return elements.flatMap((element) => {
    const negated = element.startsWith("-");
    const name = negated ? element.slice(1) : element;
    if (!name.startsWith("@")) return [element];
    const preset = presets.find((one) => one.name === name.slice(1));
    if (preset === undefined || path.includes(name)) return [];
    const inner = expand(preset.opts.types, presets, [...path, name]);
    // A negated preset is every type it names, taken back out.
    return negated ? inner.map(negate) : inner;
  });
}

function negate(element: string): string {
  return element.startsWith("-") ? element.slice(1) : `-${element}`;
}

/** The items a selection keeps, and how many of each type there were.
 *
 * The count is by type rather than a total because a total leaves the caller
 * unable to tell a dump that kept what it asked for from one whose selection
 * matched almost nothing. */
export function select(
  items: readonly Item[],
  keep: Selection,
): { items: Item[]; entries: Record<string, number> } {
  const kept: Item[] = [];
  const entries: Record<string, number> = {};
  for (const item of items) {
    if (!keep.keeps(item.type)) continue;
    kept.push(item);
    entries[item.type] = (entries[item.type] ?? 0) + 1;
  }
  return { items: kept, entries };
}
