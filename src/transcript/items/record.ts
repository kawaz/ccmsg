/** Reading values out of a transcript line.
 *
 * A transcript is another program's file: every field is optional until it has
 * been looked at, and a line that says something unexpected is a line to read
 * around rather than to fail on. These are the only place that assumption is
 * spelled out, so the classifier below can read a field and get either the
 * value or nothing. */

export type Row = Record<string, unknown>;

/** One record of a transcript and where it begins in the file.
 *
 * Classification carries the position through to the items, because an item is
 * what a reader made of a record and a reader is fallible: the position is how
 * whoever holds the item asks the transcript what the record actually said. */
export interface Located {
  readonly line: string;
  readonly offset: number;
}

/** A chunk of a transcript as its records, each with its position, where
 * `start` is the offset the chunk itself begins at.
 *
 * A record's span runs to the start of the next one — the newline that ends it
 * included — so a read bounded to `offset + bytes` carrying `bytes` returns the
 * record whole rather than everything but its terminator. Every record a
 * transcript hands out is one the writer finished and terminated; a trailing
 * fragment is not a record and is not offered here. */
export function located(chunk: string, start = 0): Located[] {
  return positioned(chunk.split("\n"), start);
}

/** Records already split out of a chunk, placed from where the chunk begins.
 * The one a tail hands over, which has done the splitting on the bytes. */
export function positioned(lines: readonly string[], start: number): Located[] {
  const found: Located[] = [];
  let offset = start;
  for (const line of lines) {
    if (line !== "") found.push({ line, offset });
    offset += span(line);
  }
  return found;
}

/** How far a record runs from where it begins, its terminator included. */
export function span(line: string): number {
  return Buffer.byteLength(line, "utf8") + 1;
}

export function isRow(raw: unknown): raw is Row {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

export function row(raw: unknown): Row | undefined {
  return isRow(raw) ? raw : undefined;
}

export function str(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

export function bool(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

export function count(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : undefined;
}

export function list(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/** An ISO instant as the milliseconds the contract counts in. A line whose
 * clock is missing or unreadable is placed at zero rather than dropped: when
 * it happened is one fact about the item, and the item is the rest. */
export function instant(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.round(at)) : 0;
}

/** The text of a `<tag>` in one of the harness's angle-bracket envelopes.
 *
 * The envelopes are written by the harness for a person to read, not parsed
 * back by anything that wrote them, so this reads them the way a person does:
 * the first opening tag to its matching close, with no nesting assumed. */
export function tagged(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const from = text.indexOf(open);
  if (from < 0) return undefined;
  const to = text.indexOf(`</${tag}>`, from + open.length);
  if (to < 0) return undefined;
  const found = text.slice(from + open.length, to).trim();
  return found === "" ? undefined : found;
}

/** Fields whose value is `undefined` are left out rather than written as null:
 * the contract's optionals mean absent, and a present null is neither. */
export function optional<K extends string, V>(
  name: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [name]: value } as Record<K, V>);
}

export function lines(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  return text.split("\n").length;
}
