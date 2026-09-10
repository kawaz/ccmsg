import type { Item } from "./item.ts";
import {
  count,
  instant,
  isRow,
  list,
  type Located,
  located,
  optional,
  type Row,
  row,
  span,
  str,
  tagged,
} from "./record.ts";
import { genericResult, resultFields, useFields } from "./tools.ts";

/** Turning a harness's transcript into the items the contract names.
 *
 * The contract writes down the type names and what an item of each type
 * carries, and says nothing about the file: the file is the harness's own, it
 * changes without asking, and reading it is this instance's work (§3.8). So
 * everything that knows what a line looks like is here, and what leaves is
 * only ever an item.
 *
 * Items are finer than lines. One assistant record holds the thinking, the
 * words and each tool call of a turn, and each of those is its own item — the
 * unit a reader selects and draws by is the thing that happened, not the line
 * the harness happened to write it on.
 *
 * Nothing is dropped for being unrecognised. A tool nobody wrote fields for
 * arrives with what it was called with, an attachment arrives under its own
 * kind, and a record that fits nothing arrives as `system:unknown`. The one
 * failure a dump cannot be read around is a line that vanished quietly. */

/** Record types that are the interface and the session's own bookkeeping
 * rather than anything that was said or done: the current mode, the title as
 * it was retitled, the queue, the file-history snapshots the editor keeps.
 *
 * They are the bulk of a transcript — more than a third of the lines in the
 * sessions this was measured against — and none of them is an event a reader
 * of a dump is looking for. */
const NOT_ITEMS = new Set([
  "mode",
  "permission-mode",
  "atis-latch",
  "ai-title",
  "custom-title",
  "last-prompt",
  "queue-operation",
  "cost-state",
  "file-history-snapshot",
  "file-history-delta",
  "bridge-session",
  "progress",
  "summary",
]);

/** The tools that start an agent, in the spellings the harness has used for
 * the one thing. Both are read the same way: the call is also a brief, and
 * what comes back is also an answer. */
const SPAWNS = new Set(["Agent", "Task"]);

/** How many calls awaiting an answer one reading holds. Reached only by calls
 * that are never answered, since an answered one is let go where it is
 * answered. */
const OUTSTANDING_CALLS = 4096;

/** What an item is under construction: the contract's shape, before it is
 * settled. A call learns the id of what answered it only when the answer
 * arrives, which is why these are written to after they are made. */
type Draft = Record<string, unknown> & {
  id: string;
  uuid: string;
  source: { offset: number; bytes: number };
  type: string;
  at: number;
};

/** A whole transcript read as items, in the order the file holds them.
 *
 * The file is read through once and the links are filled in as the answers
 * arrive, so a call and its result point at each other however many turns
 * apart the harness wrote them. Reading the whole file before any range is
 * applied is what makes `parent_item` answerable: a result inside the range
 * whose call fell before it still names the call. */
export function classify(records: Iterable<Located>): Item[] {
  const state = new Classification();
  return state.readAll(records);
}

/** A transcript read as items while it is still being written.
 *
 * The same reading as `classify`, kept open: a tail hands it what has just
 * been appended and takes back the items those bytes were, with the calls made
 * before them still known — which is what lets a result arriving now name the
 * call it answers. */
export class Classification {
  #items: Draft[] = [];
  /** The call each tool result belongs to, by the id the harness pairs them
   * with. Holds the `tool:*` item and, for an `Agent` call, the
   * `message:sub:out` beside it — the same exchange seen from the two sides
   * the contract names it from. */
  readonly #calls = new Map<string, { tool: Draft; message?: Draft; name: string }>();
  #turn = 0;
  /** The last slash command invoked, which is what its output belongs to. */
  #slash: string | undefined;

  /** The records of one chunk as the items they were read as, oldest first.
   *
   * What comes back is this chunk's items alone. A call the chunk before it
   * held is still known and can still be pointed at, but it has already been
   * handed over and is not handed over twice: whoever is reading a transcript
   * as it grows holds a list it only appends to. */
  readAll(records: Iterable<Located>): Item[] {
    for (const { line, offset } of records) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRow(parsed)) this.read(parsed, { offset, bytes: span(line) });
    }
    const made = this.#items;
    this.#items = [];
    return made as unknown as Item[];
  }

  /** A whole chunk of text as items, where the chunk begins at `start`. */
  readChunk(chunk: string, start = 0): Item[] {
    return this.readAll(located(chunk, start));
  }

  read(record: Row, source: { offset: number; bytes: number }): void {
    const type = str(record["type"]);
    if (type === undefined || NOT_ITEMS.has(type)) return;
    // A record the harness wrote without an id of its own still happened, and
    // an item is pointed at by the record it came from — so where the record
    // stands in the file stands in for the id it lacks. The `@` says which of
    // the two it is, since a reader that groups by record must not take an
    // address for something the harness will write again.
    const uuid = str(record["uuid"]) ?? `@${String(source.offset)}`;
    const at = instant(record["timestamp"]);
    // Where in its record an item stood. One record becomes the thinking, the
    // words and each call of a turn, and a link that named only the record
    // would name all of them at once.
    let index = 0;
    const make = (kind: string, fields: Record<string, unknown> = {}): Draft => {
      const draft: Draft = {
        id: `${uuid}:${String(index)}`,
        uuid,
        source,
        type: kind,
        at,
        turn: this.#turn,
        ...fields,
      };
      index += 1;
      this.#items.push(draft);
      return draft;
    };
    if (type === "attachment") return this.#attachment(record, make);
    if (type === "system") return this.#system(record, make);
    if (type === "assistant") return this.#assistant(record, make);
    if (type === "user") return this.#user(record, make);
    make("system:unknown", { record });
  }

  /** An attachment is either the operator's own code speaking or the harness
   * attaching something to a turn, and the two are kept apart because a reader
   * cares about them for opposite reasons. */
  #attachment(record: Row, make: Make): void {
    const attachment = row(record["attachment"]) ?? {};
    const kind = str(attachment["type"]);
    if (kind === "hook_additional_context" || kind === "hook_success") {
      const name = str(attachment["hookName"]) ?? "";
      // The event alone is the type. A hook runs under `PreToolUse:Bash`,
      // whose `:` would read as another level of the hierarchy and leave
      // `hook:PreToolUse` selecting nothing.
      const event = str(attachment["hookEvent"]) ?? name.split(":")[0] ?? "";
      make(`hook:${segment(event)}`, {
        hook_name: name,
        outcome: kind === "hook_success" ? "output" : "additionalContext",
        ...optional("content", text(attachment["content"])),
        ...optional("command", str(attachment["command"])),
        ...optional("exit_code", count(attachment["exitCode"])),
        ...optional("stderr", str(attachment["stderr"])),
        ...optional("duration_ms", count(attachment["durationMs"])),
        ...optional("tool_use_id", str(attachment["toolUseID"])),
      });
      return;
    }
    make(`system:attachment:${segment(kind ?? "unknown")}`, { attachment });
  }

  /** The harness files a slash command's output as a line of its own, which
   * says what came out and not what was run. The command it belongs to is the
   * one that was just invoked — the harness writes the two together — so the
   * output is reported under that name rather than under none. */
  #system(record: Row, make: Make): void {
    if (str(record["subtype"]) === "local_command") {
      const content = str(record["content"]) ?? "";
      make("notice:slash", {
        command: this.#slash ?? "",
        ...optional("stdout", tagged(content, "local-command-stdout") ?? content),
      });
      return;
    }
    make("system:unknown", { record });
  }

  #assistant(record: Row, make: Make): void {
    const message = row(record["message"]) ?? {};
    if (record["isApiErrorMessage"] === true) {
      make("system:api-error", { text: text(message["content"]) ?? "" });
      return;
    }
    for (const block of list(message["content"])) {
      const fields = row(block);
      if (fields === undefined) continue;
      const kind = str(fields["type"]);
      if (kind === "thinking") {
        const thought = str(fields["thinking"])?.trim();
        if (thought !== undefined && thought !== "") make("thinking", { text: thought });
        continue;
      }
      if (kind === "text") {
        const said = str(fields["text"])?.trim();
        if (said !== undefined && said !== "") make("message:user:out", { text: said });
        continue;
      }
      if (kind === "tool_use") this.#call(fields, make);
    }
  }

  /** One tool call, and — where the call is one session addressing another
   * mind — the message it also is.
   *
   * `Agent` is always both: the pair states that an agent was started and how
   * it ended, and the brief it was given and what it answered are the message
   * beside it. `SendMessage` and a `ccmsg` command are one or the other by
   * whom they are addressed to. */
  #call(block: Row, make: Make): void {
    const name = str(block["name"]) ?? "";
    const id = str(block["id"]) ?? "";
    const input = row(block["input"]) ?? {};
    const fields = useFields(name, input);
    const tool = make(`tool:${segment(name)}`, {
      role: "use",
      tool_use_id: id,
      ...(fields ?? { input }),
    });
    let message: Draft | undefined;
    if (SPAWNS.has(name)) {
      message = make("message:sub:out", {
        role: "use",
        tool_use_id: id,
        prompt: str(input["prompt"]) ?? "",
        ...optional("subagent_type", str(input["subagent_type"])),
        ...optional("name", str(input["name"])),
        ...optional("description", str(input["description"])),
      });
    } else if (name === "SendMessage") {
      const to = str(input["to"]) ?? "";
      // A sid is the harness's own uuid; anything else is a name, and a name
      // is how an agent below this session is addressed.
      make(addressed(to) ? "message:session:out" : "message:sub:out", {
        ...(addressed(to) ? {} : { role: "use", tool_use_id: id }),
        ...(addressed(to)
          ? { text: text(input["message"]) ?? "", to }
          : // Writing to an agent is one direction of a correspondence, not a
            // call that returns: what the agent says back arrives as its own
            // message whenever it chooses to send one, under nothing that
            // names this. So the brief says it is waiting for nothing, and a
            // reader is not left watching for an answer that has no way in.
            { prompt: text(input["message"]) ?? "", name: to, one_way: true }),
      });
    } else if (name === "Bash" && isCcmsgSend(str(input["command"]))) {
      make("message:session:out", { text: str(input["command"]) ?? "" });
    }
    if (id === "") return;
    // A call is dropped from the pairing once it has been answered, so what is
    // held here is the calls still outstanding. The bound is for the one that
    // never will be — a transcript ends mid-call, an agent is killed — which
    // otherwise accumulates for as long as the file is followed.
    if (this.#calls.size >= OUTSTANDING_CALLS) {
      const oldest = this.#calls.keys().next();
      if (oldest.done !== true) this.#calls.delete(oldest.value);
    }
    this.#calls.set(id, { tool, name, ...optional("message", message) });
  }

  #user(record: Row, make: Make): void {
    const message = row(record["message"]) ?? {};
    const content = message["content"];
    if (Array.isArray(content)) {
      let said = "";
      for (const block of list(content)) {
        const fields = row(block);
        if (fields === undefined) continue;
        if (str(fields["type"]) === "tool_result") {
          this.#answer(record, fields, make);
          continue;
        }
        const part = str(fields["text"]);
        if (part !== undefined) said += said === "" ? part : `\n${part}`;
      }
      if (said !== "") this.#said(record, said, make);
      return;
    }
    const said = str(content);
    if (said !== undefined) this.#said(record, said, make);
  }

  /** What came back from a tool call, linked to the call in both directions. */
  #answer(record: Row, block: Row, make: Make): void {
    const id = str(block["tool_use_id"]) ?? "";
    const call = this.#calls.get(id);
    if (call === undefined) {
      // An answer to a call this reading never saw. A result item names the
      // call it answers and there is no id to name, so what is stated is the
      // record itself rather than a pointer to something that does not exist.
      // It happens where a reading starts part-way down a file: the whole file
      // is read before a dump's range is applied, so the call is there.
      make("system:unknown", { record });
      return;
    }
    const failed = block["is_error"] === true;
    const answer = record["toolUseResult"];
    const fields = resultFields(call.name, answer, failed);
    const item = make(`tool:${segment(call.name)}`, {
      role: "result",
      parent_item: call.tool.id,
      parent_tool_use_id: id,
      ...(fields ?? { result: genericResult(answer) }),
    });
    call.tool["result_item"] = item.id;
    // An agent's id is known only once it has started, so the message that
    // asked for it learns its own id from the answer.
    const result = row(answer) ?? {};
    const agent = str(result["agentId"]) ?? str(result["agent_id"]);
    if (call.message === undefined) {
      // The exchange is closed: nothing else in the file points back at this
      // call, so what was held for the pairing is let go. A transcript
      // followed while it grows is read by one long-lived reading, and a call
      // kept after it was answered would be kept for the session's life.
      this.#calls.delete(id);
      return;
    }
    if (agent !== undefined) call.message["agent_id"] = agent;
    // An agent that was waited on answers here, in the call's own result. One
    // started in the background answers much later in a notification of its
    // own, and this result then says only that it was launched — so what
    // decides is whether an answer came back, not which tool was called.
    const said = answered(result["content"]);
    if (said === undefined) return;
    const reply = make("message:sub:in", {
      role: "result",
      parent_item: call.message.id,
      parent_tool_use_id: id,
      text: said,
      ...optional("agent_id", agent),
      ...optional("status", str(result["status"])),
      ...optional("duration_ms", count(result["totalDurationMs"])),
    });
    call.message["result_item"] = reply.id;
    this.#calls.delete(id);
  }

  /** A `type: "user"` line whose content is words rather than a tool's answer.
   *
   * Most of what wears this shape was not said by a person: the harness
   * reports background tasks, compaction and its own caveats in the same
   * place, and another session's message arrives inside an envelope. The
   * person's own turn is what is left when none of those match — read last,
   * so nothing the harness injected is mistaken for someone speaking. */
  #said(record: Row, said: string, make: Make): void {
    if (record["isCompactSummary"] === true) {
      make("system:compact", { text: said });
      return;
    }
    if (said.startsWith("<local-command-caveat>")) {
      make("system:caveat", { text: said });
      return;
    }
    const command = tagged(said, "command-name");
    if (command !== undefined) {
      this.#slash = command;
      make("notice:slash", {
        command,
        ...optional("args", tagged(said, "command-args") ?? tagged(said, "command-message")),
        ...optional("stdout", tagged(said, "local-command-stdout")),
      });
      return;
    }
    if (said.startsWith("[Request interrupted")) {
      make("notice:interrupt", { text: said });
      return;
    }
    if (said.startsWith("Resume the paused workflow by calling: Workflow({")) {
      make("system:resume", { text: said });
      return;
    }
    if (said.startsWith("<task-notification>")) {
      this.#notification(said, make);
      return;
    }
    // The record nothing else in the file is a reply to is the brief this
    // transcript was opened with, whoever the subject is: a person's first
    // words to a session, or the parent's instructions to an agent. An agent
    // is briefed inside the same envelope another session's message arrives
    // in, so this is read before that envelope is — from where the subject
    // stands, being told what to do is not the same as being written to.
    if (record["parentUuid"] === null) {
      this.#turn += 1;
      make("message:user:in", { text: said });
      return;
    }
    if (said.includes("<cross-session-message") || said.includes("<teammate-message")) {
      make("message:session:in", {
        text: said,
        ...optional("from", attribute(said, "from") ?? attribute(said, "teammate_id")),
        ...optional("msg_id", attribute(said, "mid")),
      });
      return;
    }
    if (record["isMeta"] === true) {
      make("system:unknown", { record });
      return;
    }
    // A turn begins where a person speaks, which is the only place a dump can
    // count turns from — the harness numbers nothing.
    this.#turn += 1;
    make("message:user:in", { text: said });
  }

  /** A background task reporting, or an agent handing back its answer.
   *
   * The two arrive in the same envelope and are told apart by what it holds: a
   * `<result>` is an agent that finished, and everything else is an event from
   * a monitor or a background command.
   *
   * What the answer belongs to is whichever call started the agent. An `Agent`
   * call has a brief, so the answer is the other half of that message; a
   * `Skill` run in the background has none, and the answer hangs off the call
   * itself. Either way it is an agent answering and reads as one. */
  #notification(said: string, make: Make): void {
    const answer = tagged(said, "result");
    const key = tagged(said, "tool-use-id") ?? "";
    const call = this.#calls.get(key);
    if (answer !== undefined && call !== undefined) {
      const asked = call.message ?? call.tool;
      const item = make("message:sub:in", {
        role: "result",
        parent_item: asked.id,
        parent_tool_use_id: key,
        text: answer,
        ...optional("agent_id", str(asked["agent_id"]) ?? tagged(said, "task-id")),
        ...optional("status", tagged(said, "status")),
        ...optional("duration_ms", count(Number(tagged(said, "duration_ms")))),
      });
      if (call.message !== undefined) call.message["result_item"] = item.id;
      this.#calls.delete(key);
      return;
    }
    make("system:task", {
      text: said,
      ...optional("task_id", tagged(said, "task-id")),
      ...optional("event", tagged(said, "event") ?? tagged(said, "summary")),
    });
  }
}

type Make = (kind: string, fields?: Record<string, unknown>) => Draft;

/** A session id as the harness writes one. What `SendMessage` addresses is
 * either this — another session — or a name, which is an agent below this
 * one. */
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addressed(to: string): boolean {
  return SID.test(to);
}

/** Whether a shell command is this session speaking to another one. */
function isCcmsgSend(command: string | undefined): boolean {
  if (command === undefined) return false;
  return /\bccmsg\s+(post|reply)\b/.test(command);
}

/** One segment of a type name. The harness's own spellings pass through — they
 * are what a reader matches against what it ran — and a character the name
 * could not carry is replaced rather than the segment being refused, so a
 * newcomer still arrives under something close to its own name. */
function segment(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, "-");
  return cleaned === "" ? "unknown" : cleaned;
}

/** An attribute of one of the harness's envelope tags. */
function attribute(said: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(said)?.[1] || undefined;
}

/** What an agent handed back, which the harness writes as the blocks of a
 * message. Nothing back is not an answer of no words: a launch says only that
 * the agent started, and reading that as an empty answer would claim it had
 * finished. */
function answered(raw: unknown): string | undefined {
  const said = text(raw)?.trim();
  return said === undefined || said === "" ? undefined : said;
}

/** A content field that is sometimes a string and sometimes the blocks of
 * one. */
function text(raw: unknown): string | undefined {
  const found = str(raw);
  if (found !== undefined) return found;
  if (!Array.isArray(raw)) return undefined;
  const parts = raw.flatMap((block) => {
    const fields = row(block);
    const part = fields === undefined ? str(block) : str(fields["text"]);
    return part === undefined ? [] : [part];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
}
