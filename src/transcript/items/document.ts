import type { DumpIdEntry, SessionDumpFile } from "@ccmsg/protocol";
import { fields, type Item } from "./item.ts";
import { elapsed, fragment, words } from "./render.ts";

/** A whole dump as one document.
 *
 * What the file holds is items in the order the transcript had them, and what
 * a person reads is that same order with the pairs put back together: a call
 * and the answer that came straight back read as one thing, and an answer that
 * arrived twenty turns later reads where it arrived, saying which call it
 * belongs to. Folding is decided here rather than in the classification,
 * because it is a fact about how far apart two items ended up in this
 * particular selection and not about what either of them is.
 *
 * An agent is the exception: its answer is drawn under the brief that asked
 * for it however many turns apart they are. The pair is a conversation with
 * somebody else, and a conversation split across the page is one nobody can
 * follow. */

/** What the file cannot say about itself: which instance wrote it, and the
 * bounds the request was made with. The file states the selection because the
 * selection decides what is inside it; a bound decides only where it stops,
 * and a reader who wants it is told here. */
export interface DumpView {
  readonly instance?: string;
  readonly since?: string;
  readonly until?: string;
  /** How much of one item's body is drawn before the rest is reported by its
   * length. Nothing is cut when nobody says: a dump is read to find out what
   * was actually written, and the reader who wants less is the one who knows
   * how much less. */
  readonly max_chars?: number;
}

const INDENT = "  ";

export function document(file: SessionDumpFile, view: DumpView = {}): string {
  const items = file.items as unknown as Item[];
  const paired = pair(items);
  const lines: string[] = [...heading(file, view)];
  lines.push("## items", "");
  if (items.length === 0) lines.push("(なし)", "");
  for (let at = 0; at < items.length; at += 1) {
    if (paired.folded.has(at)) continue;
    const item = items[at] as Item;
    const child = paired.child.get(at);
    lines.push(
      ...draw(
        item,
        child === undefined ? undefined : (items[child] as Item),
        view,
        paired.parent.get(at),
      ),
      "",
    );
  }
  lines.push(...ledger(file.ids));
  return `${lines.join("\n").trimEnd()}\n`;
}

/** What this is a dump of, before anything that happened in it. */
function heading(file: SessionDumpFile, view: DumpView): string[] {
  const subject = file.agent_id === undefined ? file.sid : `${file.sid}/agent-${file.agent_id}`;
  const lines = [`# dump ${subject}`, ""];
  lines.push(`- 対象: \`${subject}\``);
  if (view.instance !== undefined) lines.push(`- instance: \`${view.instance}\``);
  lines.push(`- 書き出し: ${new Date(file.written_at).toISOString()}`);
  lines.push(`- types: ${file.types.map((one) => `\`${one}\``).join(" ") || "(既定)"}`);
  const bounds = words(
    view.since === undefined ? undefined : `since=${view.since}`,
    view.until === undefined ? undefined : `until=${view.until}`,
  );
  if (bounds !== "") lines.push(`- 範囲: ${bounds}`);
  lines.push(`- items: ${String(file.items.length)}`, "");
  return lines;
}

/** One item, with whatever was folded into it.
 *
 * A call keeps its own heading and the answer's words are put at the end of
 * it, so `→` reads as "and this came back". An answer drawn where it arrived
 * points the other way, at a call the reader has already gone past. */
function draw(item: Item, child: Item | undefined, view: DumpView, parent?: string): string[] {
  const own = fragment(item);
  const answer = child === undefined ? undefined : fragment(child);
  const nested = child !== undefined && spoken(child.type);
  const link = isResult(item)
    ? arrow("←", parent)
    : (arrow("→", fields(item)["result_item"]) ?? waiting(item));
  const head = isResult(item)
    ? words(prefix(item), link, own.head, clock(item))
    : words(
        prefix(item),
        own.head,
        link,
        nested || answer === undefined ? undefined : answer.head,
        clock(item),
      );
  const under = [
    ...body(own.body, view),
    ...(answer === undefined || nested ? [] : body(answer.body, view)),
  ];
  const lines = [head, ...under.map((line) => `${INDENT}${line}`)];
  if (!nested || child === undefined || answer === undefined) return lines;
  // The agent's answer, under the brief that asked for it. It keeps a heading
  // of its own — it has its own instant, and often a status the brief could
  // not have known — and is indented to say whose answer it is.
  lines.push(`${INDENT}${words(prefix(child), answer.head, clock(child))}`);
  for (const line of body(answer.body, view)) lines.push(`${INDENT}${INDENT}${line}`);
  return lines;
}

/** `[id] type`, which is how an item is pointed at: the id is what the links
 * name, and the type is what the item was read as. The record's id is shown at
 * the length a person compares by eye, with the place in the record kept whole
 * — an item is one of several a record became, and a heading that dropped
 * which one would not answer the arrow pointing at it. */
function prefix(item: Item): string {
  return `[${short(item.id)}] ${item.type}`;
}

function short(id: string): string {
  const cut = id.lastIndexOf(":");
  return cut < 0 ? id.slice(0, 8) : `${id.slice(0, Math.min(8, cut))}${id.slice(cut)}`;
}

/** A call with nothing pointing back at it. Waiting and having nothing to wait
 * for read differently: an agent answers the brief that started it, and a
 * message written to one is answered wherever that agent chooses, under
 * nothing that names this. */
function waiting(item: Item): string | undefined {
  const own = fields(item);
  if (own["role"] !== "use") return undefined;
  return own["one_way"] === true ? "(片道)" : "(未着)";
}

function clock(item: Item): string {
  const at = new Date(item.at);
  const time = `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
  return item.turn === undefined ? time : `${time} turn ${String(item.turn)}`;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function arrow(mark: string, id: unknown): string | undefined {
  return typeof id === "string" && id !== "" ? `${mark} ${short(id)}` : undefined;
}

function isResult(item: Item): boolean {
  return fields(item)["role"] === "result";
}

/** The lines under a heading, cut only where a reader asked for a cut. */
function body(source: readonly string[], view: DumpView): string[] {
  const limit = view.max_chars;
  if (limit === undefined || limit <= 0) return [...source];
  const kept: string[] = [];
  let held = 0;
  for (const line of source) {
    if (held + line.length <= limit) {
      kept.push(line);
      held += line.length + 1;
      continue;
    }
    const room = Math.max(0, limit - held);
    const rest = source.join("\n").length - held - room;
    if (room > 0) kept.push(line.slice(0, room));
    kept.push(`… (残り ${String(Math.max(rest, 0))} 文字)`);
    break;
  }
  return kept;
}

/** The ids the items carried, which is what a reader descends by: the agent
 * that did the thing worth copying is named here, and dumping it is the same
 * request with that id as its subject. */
function ledger(ids: readonly DumpIdEntry[]): string[] {
  const lines = ["## ids", ""];
  if (ids.length === 0) return [...lines, "(なし)"];
  lines.push("| kind | id | label | status |", "|---|---|---|---|");
  for (const entry of ids) {
    const status = words(entry.status, elapsed(entry.duration_ms));
    lines.push(
      `| ${cell(entry.kind)} | \`${cell(entry.id)}\` | ${cell(entry.label ?? "")} | ${cell(status)} |`,
    );
  }
  return lines;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Which answer belongs to which call, which call each answer points back at,
 * and which of those pairs are drawn together.
 *
 * An answer names the call it answers, so the matching is a lookup: no two
 * calls in one record are confused for one another, and a tool and an agent
 * are paired by the same rule rather than by the ids each of them happens to
 * carry. An answer read where its call was not says instead which key the
 * harness paired them by, and the call that names that key is the one it
 * belongs to. */
function pair(items: readonly Item[]): {
  child: Map<number, number>;
  folded: Set<number>;
  parent: Map<number, string>;
} {
  const child = new Map<number, number>();
  const folded = new Set<number>();
  const parent = new Map<number, string>();
  const where = new Map<string, number>();
  const called = new Map<string, string>();
  for (let at = 0; at < items.length; at += 1) {
    const item = items[at] as Item;
    where.set(item.id, at);
    const key = fields(item)["tool_use_id"];
    if (fields(item)["role"] === "use" && typeof key === "string" && key !== "") {
      called.set(joined(item, key), item.id);
    }
  }
  for (let at = 0; at < items.length; at += 1) {
    const item = items[at] as Item;
    // Which half of an exchange this is, which the contract calls an item's
    // role and nothing here confuses with who is allowed to ask for one.
    if (fields(item)["role"] !== "result") continue;
    const named = fields(item)["parent_item"];
    const key = fields(item)["parent_tool_use_id"];
    const to =
      typeof named === "string"
        ? named
        : typeof key === "string"
          ? called.get(joined(item, key))
          : undefined;
    if (to === undefined) continue;
    parent.set(at, to);
    const call = where.get(to);
    if (call === undefined) continue;
    // A pair the reader would have to scroll between is left where each half
    // happened, unless it is an agent's: what an agent was asked and what it
    // answered are one exchange whatever fell between them.
    if (!spoken(item.type) && call !== at - 1) continue;
    child.set(call, at);
    folded.add(at);
  }
  return { child, folded, parent };
}

/** The key an exchange is joined on. One call the harness gave a key to is two
 * items where it also addressed somebody — the call and the message beside it
 * — so the side of the exchange goes into the key: a tool's answer belongs to
 * the call and an agent's to the message, and the harness's key alone would
 * not say which. */
function joined(item: Item, key: string): string {
  return `${item.type.startsWith("message:") ? "message" : "tool"}\n${key}`;
}

/** Whether an item is the conversation half of starting an agent, as opposed
 * to the call's own half. What was asked and what came back is one exchange
 * however many turns fell between them, so these are drawn together wherever
 * they ended up — a conversation split across the page is one nobody can
 * follow. */
function spoken(type: string): boolean {
  return type.startsWith("message:sub") || type.startsWith("message:team");
}
