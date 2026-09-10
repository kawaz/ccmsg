import type { Item } from "./item.ts";

/** One item as the words a person reads.
 *
 * A type is drawn by one function, the way the same type is drawn by one
 * component where the destination is a screen instead of text. What the two
 * share is the classification; how a `tool:Bash` reads is the drawing's own
 * business, and neither side carries the other's.
 *
 * A type nobody wrote a drawing for is still drawn. The generic shape says the
 * type name and lays out whatever fields the item carried, so a tool that
 * arrived after this file was written reads worse than a known one and is
 * never missing — a line that vanishes quietly is the failure a dump cannot be
 * read around. */

/** What one item says about itself: the words that belong on its heading, and
 * the lines that go under it.
 *
 * Split because a call and its answer are two items that often read as one:
 * folding them puts the answer's heading words at the end of the call's
 * heading and its lines under the call's, and neither piece has to know
 * whether that happened. */
export interface Fragment {
  readonly head: string;
  readonly body: readonly string[];
}

/** How a type is drawn. */
type Draw = (item: Item) => Fragment;

const EMPTY: readonly string[] = [];

/** The drawing for one item, whatever its type. */
export function fragment(item: Item): Fragment {
  const type = item.type;
  if (type.startsWith("tool:")) {
    const name = type.slice("tool:".length);
    const result = isResult(item);
    const draw = (result ? RESULTS : USES)[name];
    if (draw !== undefined) return draw(item);
    // A tool nothing knows the shape of arrives carrying what it was called
    // with and what it answered, which is what the generic shape lays out.
    return { head: "", body: summary(item[result ? "result" : "input"]) };
  }
  const draw = ITEMS[type];
  if (draw !== undefined) return draw(item);
  if (type.startsWith("hook:")) return hook(item);
  if (type.startsWith("system:attachment:")) return { head: "", body: summary(item["attachment"]) };
  return { head: "", body: summary(own(item)) };
}

function isResult(item: Item): boolean {
  return item["role"] === "result";
}

// --- message, thinking and the harness's own voice ---

/** The types whose whole content is what was said. Their body is the words,
 * kept as they were written: a dump is read to find out what somebody actually
 * wrote, and a reader who wants less asks for less. */
const SAID: readonly string[] = [
  "message:user:in",
  "message:user:out",
  "thinking",
  "system:compact",
];

const ITEMS: Record<string, Draw> = {
  ...Object.fromEntries(SAID.map((type) => [type, said])),

  "message:sub:out": (item) => ({
    head: words(
      field(item, "agent_id", "agent="),
      field(item, "subagent_type", "type="),
      field(item, "name", "name="),
      str(item, "description"),
    ),
    body: lines(str(item, "prompt")),
  }),

  "message:sub:in": (item) => ({
    head: words(
      field(item, "agent_id", "agent="),
      field(item, "status", "status="),
      elapsed(num(item, "duration_ms")),
    ),
    body: lines(str(item, "text")),
  }),

  "message:session:out": (item) => ({
    head: words(field(item, "to", "to="), field(item, "reply_to", "reply_to="), mid(item)),
    body: lines(str(item, "text")),
  }),

  "message:session:in": (item) => ({
    head: words(field(item, "from", "from="), mid(item)),
    body: lines(str(item, "text")),
  }),

  // A person operated the harness, or the harness spoke in someone else's
  // voice. Both are why a conversation jumps rather than part of it, so they
  // are a line each and the line names what happened. Everything the record
  // held is in the JSON dump beside this one, addressable by the id shown.
  "notice:slash": (item) => ({
    head: words(`/${str(item, "command") ?? ""}`, str(item, "args"), first(str(item, "stdout"))),
    body: EMPTY,
  }),
  "notice:interrupt": (item) => ({ head: first(str(item, "text")) ?? "", body: EMPTY }),
  "system:api-error": (item) => ({ head: first(str(item, "text")) ?? "", body: EMPTY }),
  "system:caveat": (item) => ({ head: first(str(item, "text")) ?? "", body: EMPTY }),
  "system:resume": (item) => ({ head: first(str(item, "text")) ?? "", body: EMPTY }),
  "system:task": (item) => ({
    head: words(
      field(item, "task_id", "task="),
      field(item, "event", "event="),
      first(str(item, "text")),
    ),
    body: EMPTY,
  }),
  "system:unknown": (item) => ({ head: "", body: summary(item["record"]) }),
};

function said(item: Item): Fragment {
  return { head: "", body: lines(str(item, "text")) };
}

function mid(item: Item): string | undefined {
  return field(item, "msg_id", "mid=");
}

/** The operator's own code, and what it did with its turn. */
function hook(item: Item): Fragment {
  return {
    head: words(
      str(item, "hook_name"),
      str(item, "outcome"),
      field(item, "tool_use_id", "tool="),
      exit(num(item, "exit_code")),
      elapsed(num(item, "duration_ms")),
      field(item, "stderr", "stderr="),
    ),
    body: lines(str(item, "content")),
  };
}

function exit(code: number | undefined): string | undefined {
  return code === undefined ? undefined : `exit=${String(code)}`;
}

// --- tools ---

/** What each call says on its heading and under it.
 *
 * The command, the path, the pattern: the one thing that says which call this
 * was goes on the heading, and a body is for what a reader has to look at line
 * by line rather than recognise at a glance. */
const USES: Record<string, Draw> = {
  Bash: (item) => ({
    head: str(item, "description") ?? "",
    body: lines(str(item, "command")).map((line) => `$ ${line}`),
  }),
  Read: (item) => ({
    head: words(str(item, "file_path"), at(item)),
    body: EMPTY,
  }),
  Write: (item) => ({
    head: words(str(item, "file_path"), rows(num(item, "lines"))),
    body: EMPTY,
  }),
  Edit: (item) => ({
    head: words(str(item, "file_path"), edited(item)),
    body: EMPTY,
  }),
  Grep: pattern,
  Glob: pattern,
  WebFetch: (item) => ({ head: words(str(item, "url"), str(item, "prompt")), body: EMPTY }),
  WebSearch: (item) => ({ head: field(item, "query", "query=") ?? "", body: EMPTY }),
  // The brief itself is the `message:sub:out` beside this call, so the call
  // says which agent was started and leaves the words to the message.
  Agent: (item) => ({
    head: words(
      field(item, "subagent_type", "type="),
      field(item, "name", "name="),
      str(item, "description"),
    ),
    body: EMPTY,
  }),
  SendMessage: (item) => ({
    head: words(field(item, "to", "to="), str(item, "summary")),
    body: EMPTY,
  }),
  Monitor: (item) => ({
    head: words(
      str(item, "description"),
      item["persistent"] === true ? "persistent" : undefined,
      until(num(item, "timeout_ms")),
    ),
    body: lines(str(item, "command")).map((line) => `$ ${line}`),
  }),
  Skill: (item) => ({ head: words(str(item, "skill"), str(item, "args")), body: EMPTY }),
  TodoWrite: (item) => {
    const todos = list(item["todos"]);
    const width = Math.max(0, ...todos.map((todo) => todo.status.length));
    return {
      head: `${String(todos.length)} items`,
      body: todos.map((todo) => `${todo.status.padEnd(width)}  ${todo.content}`),
    };
  },
  TaskStop: (item) => ({ head: field(item, "task_id", "task=") ?? "", body: EMPTY }),
  CronCreate: (item) => ({
    head: str(item, "cron") ?? "",
    body: lines(str(item, "prompt")),
  }),
};

/** What each answer says, on the heading it is folded into or on its own.
 *
 * An answer that is a fact about the call — how many lines, which id — is
 * heading words, so a folded pair reads as one line. An answer somebody has to
 * read is a body. */
const RESULTS: Record<string, Draw> = {
  Bash: (item) => ({
    head: item["interrupted"] === true ? "中断" : "",
    body: [...stream("stdout", str(item, "stdout")), ...stream("stderr", str(item, "stderr"))],
  }),
  Read: (item) => ({
    head: words(rows(num(item, "lines")), bytes(num(item, "bytes"))),
    body: EMPTY,
  }),
  Write: ok,
  Edit: ok,
  Grep: hits,
  Glob: hits,
  WebFetch: (item) => ({ head: "", body: lines(str(item, "text")) }),
  WebSearch: (item) => {
    const found = num(item, "results");
    return { head: found === undefined ? "" : `${String(found)} results`, body: EMPTY };
  },
  Agent: (item) => ({
    head: words(field(item, "agent_id", "agent="), field(item, "status", "status=")),
    body: EMPTY,
  }),
  SendMessage: (item) => ({
    head: words(mid(item), field(item, "routing", "routing=")),
    body: EMPTY,
  }),
  Monitor: (item) => ({ head: field(item, "task_id", "task=") ?? "", body: EMPTY }),
  Skill: (item) => ({
    head: words(
      field(item, "agent_id", "agent="),
      item["background"] === true ? "background" : undefined,
      field(item, "status", "status="),
    ),
    body: EMPTY,
  }),
  TodoWrite: ok,
  TaskStop: ok,
  CronCreate: (item) => ({ head: field(item, "cron_id", "cron=") ?? "", body: EMPTY }),
};

function pattern(item: Item): Fragment {
  return {
    head: words(field(item, "pattern", "pattern="), field(item, "path", "path=")),
    body: EMPTY,
  };
}

/** A tool that says nothing but whether it worked. Success is the silent case:
 * a heading crowded with `ok` is a heading nobody reads. */
function ok(item: Item): Fragment {
  return { head: item["ok"] === false ? "失敗" : "", body: EMPTY };
}

function hits(item: Item): Fragment {
  const found = num(item, "matches");
  return { head: found === undefined ? "" : `${String(found)} hits`, body: EMPTY };
}

/** One of a shell call's two streams, kept whole. A single line sits beside
 * its name; more than one goes under it, because a stream that needs reading
 * needs its own left edge. */
function stream(name: string, text: string | undefined): string[] {
  const rows = lines(text);
  if (rows.length === 0) return [];
  if (rows.length === 1) return [`${name}  ${rows[0] as string}`];
  return [name, ...rows.map((line) => `  ${line}`)];
}

function at(item: Item): string | undefined {
  const offset = num(item, "offset");
  const limit = num(item, "limit");
  if (offset === undefined && limit === undefined) return undefined;
  return `${String(offset ?? 0)}+${limit === undefined ? "" : String(limit)}`;
}

function edited(item: Item): string | undefined {
  const old = num(item, "old_lines");
  const fresh = num(item, "new_lines");
  if (old === undefined && fresh === undefined) return undefined;
  return `-${String(old ?? 0)} +${String(fresh ?? 0)}`;
}

function rows(count: number | undefined): string | undefined {
  return count === undefined ? undefined : `${String(count)} 行`;
}

function bytes(count: number | undefined): string | undefined {
  return count === undefined ? undefined : `${String(count)} B`;
}

function until(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : `timeout=${elapsed(ms) ?? ""}`;
}

// --- the pieces every drawing is made of ---

function str(item: Item, name: string): string | undefined {
  const value = item[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(item: Item, name: string): number | undefined {
  const value = item[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function field(item: Item, name: string, label: string): string | undefined {
  const value = str(item, name);
  return value === undefined ? undefined : `${label}${value}`;
}

/** Heading words, separated by the two spaces that keep them apart without
 * inventing a syntax to parse. */
export function words(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join("  ");
}

function lines(text: string | undefined): string[] {
  if (text === undefined) return [];
  const body = text.replace(/\s+$/, "");
  return body === "" ? [] : body.split("\n");
}

/** The first line of something that is drawn as one line, saying that there is
 * more where the rest was left in the file beside this one. */
function first(text: string | undefined): string | undefined {
  const rows = lines(text);
  const head = rows[0];
  if (head === undefined) return undefined;
  return rows.length === 1 ? head : `${head} …`;
}

/** A duration in the units a person compares them in. */
export function elapsed(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1_000) return `${String(Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m${String(seconds % 60).padStart(2, "0")}s`;
}

interface Todo {
  readonly content: string;
  readonly status: string;
}

function list(value: unknown): Todo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const each = entry as Record<string, unknown>;
    const content = each["content"];
    const status = each["status"];
    return typeof content === "string" && typeof status === "string" ? [{ content, status }] : [];
  });
}

/** The base fields every item has, which the heading already said. What is
 * left is the type's own, and that is what a generic drawing lays out. */
const BASE = new Set(["uuid", "type", "at", "turn", "role", "result_item", "parent_item"]);

function own(item: Item): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([name]) => !BASE.has(name)));
}

/** How deep a value nobody wrote a drawing for is laid out. Two levels is what
 * shows a record's shape — its fields, and what each of them is — without the
 * drawing becoming the file. */
const DEPTH = 2;

/** How long a value is quoted before it is reported by its length instead. */
const VALUE = 200;

/** Whatever it was, as lines under a heading.
 *
 * Not JSON: the reader of a dump is looking for what happened, and a nested
 * object's punctuation is in the way of that. One field per line, flattened by
 * the path it sits at, with what is deeper than the layout goes said by its
 * shape rather than shown. */
function summary(value: unknown, depth = DEPTH, path = ""): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null)
    return [`${path}${path === "" ? "" : "  "}${scalar(value)}`];
  if (Array.isArray(value)) {
    if (depth <= 0) return [`${path}  [${String(value.length)} 件]`];
    return value.flatMap((entry, index) => summary(entry, depth - 1, `${path}[${String(index)}]`));
  }
  const fields = Object.entries(value as Record<string, unknown>);
  if (depth <= 0) return [`${path}  {${fields.map(([name]) => name).join(", ")}}`];
  return fields.flatMap(([name, each]) =>
    summary(each, depth - 1, path === "" ? name : `${path}.${name}`),
  );
}

function scalar(value: unknown): string {
  if (typeof value !== "string") return String(value);
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= VALUE
    ? single
    : `${single.slice(0, VALUE)}… (${String(single.length)} 文字)`;
}
