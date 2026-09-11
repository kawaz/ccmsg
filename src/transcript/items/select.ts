import type { DumpPreset } from "@ccmsg/protocol";
import { OpError } from "../../dispatch/index.ts";
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
 * A prefix matches at segment boundaries, so `tool` reaches `tool.Bash` and
 * `message.user` reaches both directions, while `notice` never reaches a type
 * that merely starts with those letters. */

/** What a dump keeps when nobody said: every family there is, less the
 * attachments — the harness furnishing a turn rather than anything that
 * happened in it, and more numerous than everything else together.
 *
 * Written as selectors a person could have typed, rather than as a wildcard
 * this alone understands, because the file states the selection it was written
 * under and a reader of that file has only the one vocabulary. */
const DEFAULT_TYPES = [
  "message",
  "thinking",
  "tool",
  "notice",
  "system",
  "hook",
  "-system.attachment",
];

export interface Selection {
  /** Whether an item of this type is kept. */
  readonly keeps: (type: string) => boolean;
  /** The selection as applied: presets expanded and exclusions in place, which
   * is what the dump file repeats so it says on its own what was left out. */
  readonly elements: readonly string[];
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
const NO_AGENT = ["-message.sub", "-tool.Agent"];

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
    elements,
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
  return type === name || type.startsWith(`${name}.`);
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

/** Where a range of a transcript begins and ends.
 *
 * A record bound cuts at that record's position rather than at its clock, so
 * records sharing an instant stay on their own side of the cut — which is the
 * whole reason there are two kinds. An item bound is finer than either: it
 * cuts inside a record whose other items were already answered for, closed at
 * the lower end where it resumes a read and open at the upper end where it
 * stops short of what the caller already holds. */
export interface Bounds {
  readonly since_at?: number;
  readonly since_uuid?: string;
  readonly since_id?: string;
  readonly until_at?: number;
  readonly until_uuid?: string;
  readonly until_id?: string;
}

/** The bounds as stated, refused where they say two things at once.
 *
 * A range with two lower bounds has no reading that is not a guess at which
 * one was meant, and a guess that answers the wrong slice is worse than a
 * refusal the caller can act on. */
export function bounded(bounds: Bounds): void {
  const lower = [bounds.since_at, bounds.since_uuid, bounds.since_id].filter(
    (one) => one !== undefined,
  ).length;
  if (lower > 1) {
    throw new OpError("invalid_args", "a lower bound is a time, a record or an item, not several");
  }
  const upper = [bounds.until_at, bounds.until_uuid, bounds.until_id].filter(
    (one) => one !== undefined,
  ).length;
  if (upper > 1) {
    throw new OpError("invalid_args", "an upper bound is a time, a record or an item, not several");
  }
}

/** The items within the bounds, in the order the transcript holds them.
 *
 * Every item a record became carries that record's id, so a bound by record
 * keeps a turn's thinking, words and calls together, while a bound by item
 * cuts inside one. */
export function within(items: readonly Item[], bounds: Bounds): Item[] {
  const kept: Item[] = [];
  // A lower bound by record or by item starts closed: it opens at what it
  // names, which is included.
  let open = bounds.since_uuid === undefined && bounds.since_id === undefined;
  for (let at = 0; at < items.length; at += 1) {
    const item = items[at];
    if (item === undefined) continue;
    if (!open) {
      if (
        bounds.since_id !== undefined
          ? item.id !== bounds.since_id
          : item.uuid !== bounds.since_uuid
      ) {
        continue;
      }
      open = true;
    }
    if (bounds.since_at !== undefined && item.at < bounds.since_at) continue;
    if (bounds.until_at !== undefined && item.at > bounds.until_at) break;
    // An upper bound by item is open: it names an item the caller already
    // holds, so the range ends before it rather than at it.
    if (bounds.until_id !== undefined && item.id === bounds.until_id) break;
    kept.push(item);
    // An upper bound by record is inclusive and cuts after the last item that
    // record became, so the rest of the same record is still let through.
    if (bounds.until_uuid !== undefined && item.uuid === bounds.until_uuid) {
      if (items[at + 1]?.uuid !== item.uuid) break;
    }
  }
  return kept;
}
