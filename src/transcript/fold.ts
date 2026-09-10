import { isAbsolute } from "node:path";
import type {
  AgentTreeGroups,
  AgentTreeNode,
  ExternalFile,
  SessionApiError,
  SessionBackgroundStatus,
  SessionTeammate,
  SessionTodo,
  SessionWorkflowStatus,
  Timestamp,
} from "@ccmsg/protocol";

/** Everything one session's transcript is folded into (§3.3).
 *
 * One fold, not one per consumer: the same line settles whether the session is
 * stopped, when a person last spoke to it, which files it named and what is
 * running below it, so it is read once and every value it can settle is
 * settled from that read (M5). The two optional fields are absent until a line
 * says otherwise, and the lists are empty — which is what a transcript that has
 * not been read yet looks like, and is also the contract's "nothing was
 * declared". */
export interface TranscriptFacts {
  /** The error the latest turn ended on. Present only while it stands: a real
   * turn after it clears it, so this is the session's current state and not
   * every error it ever hit. One of the two things §5.2 calls Waiting. */
  readonly api_error?: SessionApiError;
  /** When a person last put something into the session (§5.3). */
  readonly last_user_input_at?: Timestamp;
  /** What answered on the latest turn, and how hard it was asked to think.
   *
   * Both are the transcript's answer rather than the greeting's: a session
   * names its model once, when it greets, and `/model` and `/effort` move it
   * afterwards without saying so again. The two are read off the same row, so
   * they can never describe different turns. */
  readonly model?: string;
  readonly effort?: string;
  /** Every absolute path the transcript named, whichever way it named it.
   *
   * Not yet the contract's `external_files`, which is the paths outside the
   * session's root: the root is a greeting's fact and the fold holds no
   * greeting, so the fold states what was named and the filter runs where the
   * root is known. */
  readonly named_files: readonly ExternalFile[];
  readonly todos: readonly SessionTodo[];
  readonly teammates: readonly SessionTeammate[];
  readonly background: readonly SessionBackgroundStatus[];
  readonly workflows: readonly SessionWorkflowStatus[];
  readonly agent_tree: AgentTreeGroups;
}

/** What a transcript nobody has read yet says. Every list empty rather than
 * absent, so a consumer never has to tell "not read" from "nothing declared" —
 * the contract spells both the same way. */
export const NO_FACTS: TranscriptFacts = {
  named_files: [],
  todos: [],
  teammates: [],
  background: [],
  workflows: [],
  agent_tree: { teammates: [], agents: [], workflows: [] },
};

/** The one place a transcript line is interpreted.
 *
 * Nothing outside this module parses a transcript record. A line arrives, the
 * fold updates what it can from it, and the values the domain states are read
 * off the result — so a value can never be derived by two different readings
 * of the same file (§3.3, M5).
 *
 * Feeding lines is order-dependent by design: the api error is the state of
 * the latest turn, so a later line undoing an earlier one is the point.
 * `reset` starts over, which is what a rewritten transcript needs. */
export class TranscriptFold {
  #apiError: SessionApiError | undefined;
  #lastUserInputAt: Timestamp | undefined;
  #model: string | undefined;
  #effort: string | undefined;
  /** Paths in the order they were first named, so the value is stable across
   * reads of the same file. */
  readonly #files = new Map<string, ExternalFile>();
  readonly #todos = new Map<string, SessionTodo>();
  readonly #teammates = new Map<string, Teammate>();
  readonly #background = new Map<string, Mutable<SessionBackgroundStatus>>();
  readonly #workflows = new Map<string, Mutable<SessionWorkflowStatus>>();
  readonly #agents = new Map<string, Mutable<AgentTreeNode>>();
  /** A tool call waiting for its result. The call carries the arguments and the
   * result carries the identifiers the arguments never mention, so neither half
   * describes what started on its own. */
  readonly #calls = new Map<string, PendingCall>();

  get facts(): TranscriptFacts {
    return {
      ...(this.#apiError === undefined ? {} : { api_error: this.#apiError }),
      ...(this.#lastUserInputAt === undefined ? {} : { last_user_input_at: this.#lastUserInputAt }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#effort === undefined ? {} : { effort: this.#effort }),
      named_files: [...this.#files.values()],
      todos: [...this.#todos.values()],
      teammates: [...this.#teammates.values()].map((each) => each.status),
      background: [...this.#background.values()],
      workflows: [...this.#workflows.values()],
      agent_tree: this.#agentTree(),
    };
  }

  reset(): void {
    this.#apiError = undefined;
    this.#lastUserInputAt = undefined;
    this.#model = undefined;
    this.#effort = undefined;
    this.#files.clear();
    this.#todos.clear();
    this.#teammates.clear();
    this.#background.clear();
    this.#workflows.clear();
    this.#agents.clear();
    this.#calls.clear();
  }

  /** Fold one whole record. Answers whether anything a consumer reads changed,
   * so a file that grew without saying anything new publishes nothing.
   *
   * A line that is not JSON is skipped rather than treated as an error: the
   * transcript is written by another process, and a record still being written
   * is only ever half a line. */
  line(text: string): boolean {
    if (text.length === 0) return false;
    let row: unknown;
    try {
      row = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isRecord(row)) return false;
    // A Codex rollout line settles one of these facts and none of the others,
    // so it is folded on its own rather than run past readers of records it
    // does not have (§3.8).
    const rollout = rolloutRecord(row, str(row["type"]));
    if (rollout !== undefined) return this.#foldRollout(rollout);
    // Every value this fold derives, derived from the one parse (M5).
    let changed = this.#foldApiError(row);
    if (this.#foldAnswered(row)) changed = true;
    if (this.#foldUserInput(row)) changed = true;
    if (this.#foldCalls(row)) changed = true;
    if (this.#foldResult(row)) changed = true;
    if (this.#foldRelay(row)) changed = true;
    if (this.#foldAttachment(row)) changed = true;
    if (this.#foldNotification(row)) changed = true;
    return changed;
  }

  /** The api-error state, from an assistant row.
   *
   * The harness writes its own failures as assistant messages carrying
   * `isApiErrorMessage: true` ("Prompt is too long", "API Error: 500 …",
   * "Please run /login"): the turn stopped and the session sits idle until a
   * person intervenes, which is why it counts as Waiting (§5.2). A row the
   * model actually produced clears it — a row the harness wrote itself carries
   * `model: "<synthetic>"` and does not, so the harness's own "No response
   * requested." cannot pass for the agent answering again. A user row is not a
   * clear either: a person typing does not resolve the error, and the
   * assistant row that follows settles it either way.
   *
   * Sidechain rows never signal. A subagent's transcript interleaves into the
   * same file, and neither its failure nor its recovery describes what the
   * session's main context is doing.
   *
   * Each condition above is the old daemon's observation of real transcripts,
   * carried over as an observed fact about the harness rather than as a rule
   * this daemon chose. */
  #foldApiError(row: Record<string, unknown>): boolean {
    if (row["type"] !== "assistant" || row["isSidechain"] === true) return false;
    const message = row["message"];
    if (!isRecord(message)) return false;
    if (row["isApiErrorMessage"] !== true) {
      const model = str(message["model"]);
      if (model === undefined || model === "<synthetic>") return false;
      if (this.#apiError === undefined) return false;
      this.#apiError = undefined;
      return true;
    }
    const text = blockText(message["content"]);
    if (text === undefined) return false;
    const occurredAt = instant(row["timestamp"]);
    if (occurredAt === undefined) return false;
    // A stall writes several error rows as it is retried; the newest is the
    // one the person is stuck on.
    if (this.#apiError?.text === text && this.#apiError.occurred_at === occurredAt) return false;
    this.#apiError = { text, occurred_at: occurredAt };
    return true;
  }

  /** What answered the latest turn, from an assistant row.
   *
   * The model sits on `message.model` and the effort beside it on the row, and
   * both are taken from the same row so that they describe one turn. The
   * newest row wins outright: a session moved to another model mid-transcript
   * is on that model now, which is the whole reason this is not the greeting's
   * value.
   *
   * A row the harness wrote itself carries `model: "<synthetic>"` and says
   * nothing about what is answering, and a sidechain row is a subagent, which
   * runs on a model of its own. Effort absent from an otherwise real row
   * clears what an earlier row said rather than keeping it: the row states the
   * turn, and a turn that names no effort has none to report. */
  #foldAnswered(row: Record<string, unknown>): boolean {
    if (row["type"] !== "assistant" || row["isSidechain"] === true) return false;
    const message = row["message"];
    if (!isRecord(message)) return false;
    const model = str(message["model"]);
    if (model === undefined || model === "<synthetic>") return false;
    const effort = str(row["effort"]);
    if (this.#model === model && this.#effort === effort) return false;
    this.#model = model;
    this.#effort = effort;
    return true;
  }

  /** When a person last spoke, from a user row.
   *
   * A user row is only sometimes a person: the harness injects skill bodies,
   * command caveats and notifications as user rows too. `isMeta: true` marks
   * an injection and `promptSource: "system"` marks a row the harness raised
   * on its own — neither is someone typing. The remaining exclusions are by
   * the text's opening, which is how the injections that carry neither marker
   * were observed to be recognisable.
   *
   * A sidechain user row is a subagent being prompted by its parent, which is
   * a session speaking to itself rather than a person speaking to it. */
  /** What a Codex rollout says: when a person last spoke.
   *
   * The rest of what this fold holds — the api error, the model of the latest
   * turn, todos, teammates, background work — are records Claude Code writes
   * and a rollout does not, so they stay as they are for a Codex session
   * rather than being guessed at from something that resembles them. */
  #foldRollout(record: TranscriptRecord): boolean {
    if (record.said_by !== "user" || record.said_at === undefined) return false;
    if (record.text === undefined || !isHuman(record.text)) return false;
    if ((this.#lastUserInputAt ?? 0) >= record.said_at) return false;
    this.#lastUserInputAt = record.said_at;
    return true;
  }

  #foldUserInput(row: Record<string, unknown>): boolean {
    if (row["type"] !== "user" || row["isSidechain"] === true) return false;
    if (row["isMeta"] === true || row["promptSource"] === "system") return false;
    const message = row["message"];
    if (!isRecord(message)) return false;
    const text = blockText(message["content"]);
    if (text === undefined || !isHuman(text)) return false;
    const at = instant(row["timestamp"]);
    // Only forwards: a transcript is appended in order, and a row without a
    // readable instant says nothing about when anyone spoke.
    if (at === undefined || (this.#lastUserInputAt ?? 0) >= at) return false;
    this.#lastUserInputAt = at;
    return true;
  }

  /** The tool calls an assistant row makes.
   *
   * A file tool settles here rather than on its result: the call already
   * carries the path, and the old daemon observed a read whose result never
   * arrived as still having named the file. Everything else waits, because the
   * identifiers a started thing is known by — a background task's id, a
   * teammate's, a workflow's run — appear only in the result.
   *
   * A sidechain row names files the same way any other does: the contract asks
   * which paths the transcript names, and a subagent's read is one of them. It
   * starts nothing, though — a spawn made inside a subagent is that subagent's
   * child, not the session's, and this fold can only see depth from the file
   * the spawn was written in. */
  #foldCalls(row: Record<string, unknown>): boolean {
    if (row["type"] !== "assistant") return false;
    const message = row["message"];
    if (!isRecord(message)) return false;
    const content = message["content"];
    if (!Array.isArray(content)) return false;
    const sidechain = row["isSidechain"] === true;
    const at = instant(row["timestamp"]);
    let changed = false;
    for (const block of content) {
      if (!isRecord(block) || block["type"] !== "tool_use") continue;
      const name = str(block["name"]);
      if (name === undefined) continue;
      const input = isRecord(block["input"]) ? block["input"] : {};
      const field = FILE_INPUT[name];
      if (field !== undefined && this.#named(str(input[field]), "tool")) changed = true;
      const id = str(block["id"]);
      if (sidechain || id === undefined) continue;
      // Oldest out first: a call whose result never came is the one least
      // likely to still be answered.
      if (this.#calls.size >= MAX_PENDING_CALLS) {
        const oldest = this.#calls.keys().next();
        if (oldest.done !== true) this.#calls.delete(oldest.value);
      }
      this.#calls.set(id, { name, input, ...optional("at", at) });
    }
    return changed;
  }

  /** What a tool call turned out to have started, from the user row carrying
   * its result. The arguments and the result are read together because neither
   * half names the thing on its own. */
  #foldResult(row: Record<string, unknown>): boolean {
    if (row["type"] !== "user") return false;
    const message = row["message"];
    if (!isRecord(message)) return false;
    const content = message["content"];
    if (!Array.isArray(content)) return false;
    // One result per row, as the harness writes them, so the row's own
    // `toolUseResult` belongs to the block that names the call.
    const result = isRecord(row["toolUseResult"]) ? row["toolUseResult"] : undefined;
    let changed = false;
    for (const block of content) {
      if (!isRecord(block) || block["type"] !== "tool_result") continue;
      const id = str(block["tool_use_id"]);
      if (id === undefined) continue;
      const call = this.#calls.get(id);
      this.#calls.delete(id);
      // A call that failed started nothing, and a result the harness wrote in
      // some other shape says nothing this fold can read.
      if (call === undefined || result === undefined || block["is_error"] === true) continue;
      if (this.#started(call, result)) changed = true;
    }
    return changed;
  }

  /** One completed call, in the kinds the old daemon observed results for. */
  #started(call: PendingCall, result: Record<string, unknown>): boolean {
    switch (call.name) {
      case "Agent":
        // The one call with two outcomes: a long-lived member of the team, or
        // a one-off spawn. The result says which.
        return str(result["status"]) === "teammate_spawned"
          ? this.#teammateSpawned(call, result)
          : this.#agentSpawned(call, result);
      case "Monitor":
        return this.#running(str(result["taskId"]), "monitor", call, {});
      case "Bash":
        // Only a background one is a task; a foreground command is the turn.
        return call.input["run_in_background"] === true
          ? this.#running(str(result["backgroundTaskId"]), "bash", call, {})
          : false;
      case "Workflow":
        return this.#workflowStarted(call, result);
      case "SendMessage":
        return result["success"] === true
          ? this.#teammate(str(call.input["to"]), (each) => {
              each.last_sent_at = call.at;
            })
          : false;
      case "TaskStop":
        return this.#stopped(str(call.input["task_id"]), result);
      case "TaskCreate":
      case "TaskUpdate":
        return this.#todo(call, result);
      default:
        return false;
    }
  }

  #teammateSpawned(call: PendingCall, result: Record<string, unknown>): boolean {
    const name = str(result["name"]) ?? str(call.input["name"]);
    return this.#teammate(name, (each, side) => {
      each.spawned = true;
      each.state = "active";
      each.spawned_at = call.at;
      each.agent_type = str(result["agent_type"]);
      each.color = str(result["color"]);
      each.model = str(result["model"]);
      side.agent_id = str(result["agent_id"]);
      side.team_name = str(result["team_name"]);
    });
  }

  /** A one-off spawn: a background task to whoever is watching the session, and
   * a node of the tree below it. Both come from this one result, so the two
   * cannot disagree about what was started. */
  #agentSpawned(call: PendingCall, result: Record<string, unknown>): boolean {
    const id = str(result["agentId"]);
    if (id === undefined) return false;
    // A spawn the caller waits for has already finished by the time its result
    // is written; one launched asynchronously is still going.
    const async = result["isAsync"] === true || launched(str(result["status"]));
    const state = async ? "running" : (str(result["status"]) ?? "completed");
    const agentType = str(call.input["subagent_type"]) ?? str(result["agentType"]);
    this.#running(id, "agent", call, {
      status: state,
      ...optional("agent_type", agentType),
      ...(async ? {} : optional("ended_at", call.at)),
    });
    this.#agents.set(id, {
      agent_id: id,
      spawn_depth: 0,
      kind: "subagent",
      state,
      children: [],
      ...optional("agent_type", agentType),
      ...optional("description", str(call.input["description"])),
      ...optional("model", str(result["resolvedModel"]) ?? str(call.input["model"])),
      ...optional("last_activity_at", call.at),
    });
    return true;
  }

  #workflowStarted(call: PendingCall, result: Record<string, unknown>): boolean {
    const taskId = str(result["taskId"]);
    const name = str(result["workflowName"]);
    if (taskId === undefined || name === undefined || call.at === undefined) return false;
    this.#workflows.set(taskId, {
      task_id: taskId,
      name,
      // A run that has only just been launched is running; the record it
      // writes at the end is what says how it went.
      status: launched(str(result["status"])) ? "running" : (str(result["status"]) ?? "running"),
      started_at: call.at,
      // Declared in the record the run writes when it ends, which is a file
      // beside the transcript rather than a line in it.
      phases: [],
      agents: [],
      ...optional("summary", str(result["summary"])),
      ...optional("run_id", str(result["runId"])),
    });
    return true;
  }

  /** A background task, in the three kinds the contract distinguishes. */
  #running(
    taskId: string | undefined,
    kind: SessionBackgroundStatus["kind"],
    call: PendingCall,
    over: Partial<SessionBackgroundStatus>,
  ): boolean {
    if (taskId === undefined || call.at === undefined) return false;
    this.#background.set(taskId, {
      task_id: taskId,
      kind,
      description: str(call.input["description"]) ?? "",
      status: "running",
      started_at: call.at,
      ...over,
    });
    return true;
  }

  /** `TaskStop` names one thing by id without saying which kind it was, so each
   * place a task can be is tried in turn. */
  #stopped(taskId: string | undefined, result: Record<string, unknown>): boolean {
    if (taskId === undefined) return false;
    if (str(result["task_type"]) === "in_process_teammate") {
      return this.#teammate(taskId, (each) => {
        each.state = "stopped";
      });
    }
    return this.#ended(taskId, "stopped", undefined);
  }

  /** One started thing reaching its end, wherever it is held.
   *
   * A spawned agent is in two places — the background list and the tree — and
   * both are settled here, so what a reader is told about the same agent
   * cannot differ between the two. */
  #ended(taskId: string, status: string, at: Timestamp | undefined): boolean {
    let changed = false;
    for (const where of [this.#workflows, this.#background]) {
      const entry = where.get(taskId);
      if (entry === undefined) continue;
      entry.status = status;
      if (at !== undefined) entry.ended_at = at;
      changed = true;
    }
    const agent = this.#agents.get(taskId);
    if (agent !== undefined) {
      agent.state = status;
      if (at !== undefined) agent.last_activity_at = at;
      changed = true;
    }
    return changed;
  }

  /** The session's task list, as the two calls that write it leave it.
   *
   * `TaskCreate` states a task and `TaskUpdate` changes one, and an update adds
   * to the dependency lists rather than replacing them — which is the shape of
   * its arguments, since it names what to add. */
  #todo(call: PendingCall, result: Record<string, unknown>): boolean {
    const task = isRecord(result["task"]) ? result["task"] : undefined;
    const id = str(call.input["taskId"]) ?? str(result["taskId"]) ?? str(task?.["id"]);
    if (id === undefined) return false;
    if (str(call.input["status"]) === "deleted") return this.#todos.delete(id);
    const before = this.#todos.get(id);
    const subject =
      str(call.input["subject"]) ?? str(task?.["subject"]) ?? before?.subject ?? "(unknown)";
    const status = str(call.input["status"]) ?? before?.status ?? "pending";
    this.#todos.set(id, {
      id,
      subject,
      status,
      blocked_by: merge(before?.blocked_by, call.input["addBlockedBy"]),
      blocks: merge(before?.blocks, call.input["addBlocks"]),
      ...optional("owner", str(call.input["owner"]) ?? before?.owner),
    });
    return true;
  }

  /** A message from a teammate, which the harness relays into the session as a
   * user row wrapping it in a tag. It is the only sign a teammate gives of
   * still being there, so it is also where its liveness comes from. */
  #foldRelay(row: Record<string, unknown>): boolean {
    if (row["type"] !== "user") return false;
    const message = row["message"];
    if (!isRecord(message)) return false;
    const text = blockText(message["content"]);
    if (text === undefined) return false;
    const relay = RELAY.exec(text);
    if (relay === null) return false;
    const name = relay[1];
    // The harness speaks under this name itself; it is not a member of the team.
    if (name === undefined || name === "system") return false;
    const at = instant(row["timestamp"]);
    return this.#teammate(name, (each) => {
      each.last_received_at = at;
      each.state = (relay[2] ?? "").trimStart().startsWith(IDLE) ? "idle" : "active";
    });
  }

  /** The records the harness writes for something attached to a turn rather
   * than said in it: a file the person put in front of the session, and the
   * task list a subagent's work left changed. */
  #foldAttachment(row: Record<string, unknown>): boolean {
    if (row["type"] !== "attachment") return false;
    const attachment = row["attachment"];
    if (!isRecord(attachment)) return false;
    const kind = str(attachment["type"]);
    if (kind === undefined) return false;
    if (kind === "task_reminder") return this.#reminded(attachment);
    const field = ATTACHMENT_FILE[kind];
    return field === undefined ? false : this.#named(str(attachment[field]), "attachment");
  }

  /** The whole task list, restated. This is the only sight of a task a subagent
   * created, so the list is upserted rather than replaced: a reminder that
   * omits a task is not the harness saying the task is gone, and deletion has
   * its own call. */
  #reminded(attachment: Record<string, unknown>): boolean {
    const content = attachment["content"];
    if (!Array.isArray(content)) return false;
    let changed = false;
    for (const item of content) {
      if (!isRecord(item)) continue;
      const id = str(item["id"]);
      const subject = str(item["subject"]);
      const status = str(item["status"]);
      if (id === undefined || subject === undefined || status === undefined) continue;
      this.#todos.set(id, {
        id,
        subject,
        status,
        blocked_by: merge(undefined, item["blockedBy"]),
        blocks: merge(undefined, item["blocks"]),
        ...optional("owner", str(item["owner"])),
      });
      changed = true;
    }
    return changed;
  }

  /** How a started thing is seen to end. The harness queues the notification
   * into the session, and the queue row is the only place the outcome appears —
   * the tool result was written when the thing started. */
  #foldNotification(row: Record<string, unknown>): boolean {
    if (row["type"] !== "queue-operation" || row["operation"] !== "enqueue") return false;
    const content = str(row["content"]);
    if (content === undefined || !content.includes("<task-notification>")) return false;
    // Only as far as the notification's own summary: everything after it is
    // text somebody else wrote, and could spell these tags itself.
    const head = content.slice(0, cut(content));
    const taskId = tagged(head, "task-id");
    const status = tagged(head, "status");
    if (taskId === undefined || status === undefined || status === "running") return false;
    return this.#ended(taskId, status, instant(row["timestamp"]));
  }

  /** One path the transcript named. A path named both ways keeps the origin it
   * was first seen with, which is what the contract states; a tool naming a
   * path an attachment already carried is still the same file. */
  #named(path: string | undefined, origin: ExternalFile["origin"]): boolean {
    if (path === undefined || !isAbsolute(path) || this.#files.has(path)) return false;
    this.#files.set(path, { path, origin });
    return true;
  }

  /** A teammate by name, created on first sight. Every route to one goes
   * through here: a spawn, a message out, a message back and a stop are four
   * sightings of one member, and four spellings of "the same name" could come
   * apart. */
  #teammate(
    name: string | undefined,
    change: (status: Mutable<SessionTeammate>, side: Teammate) => void,
  ): boolean {
    if (name === undefined) return false;
    const held = this.#teammates.get(name) ?? {
      // Seen only by having spoken: it exists, but this transcript never
      // watched it start.
      status: { name, spawned: false, state: "active" },
    };
    change(held.status, held);
    this.#teammates.set(name, held);
    return true;
  }

  /** What the transcript itself says is running below the session.
   *
   * Direct children only, all at depth zero: a spawn is written in the file of
   * whoever made it, so the session's own transcript names the agents it
   * started and says nothing about what those in turn started. Depth, workflow
   * membership and an agent's own last activity are read from the files the
   * harness writes beside the transcript — a source this fold does not have —
   * so the workflow group stays empty rather than being guessed at. */
  #agentTree(): AgentTreeGroups {
    const teammates: AgentTreeNode[] = [];
    for (const held of this.#teammates.values()) {
      const { status } = held;
      if (held.agent_id === undefined) continue;
      teammates.push({
        agent_id: held.agent_id,
        teammate_name: status.name,
        spawn_depth: 0,
        kind: "teammate",
        state: status.state,
        children: [],
        ...optional("agent_type", status.agent_type),
        ...optional("color", status.color),
        ...optional("model", status.model),
        ...optional("team_name", held.team_name),
        ...optional(
          "last_activity_at",
          status.last_received_at ?? status.last_sent_at ?? status.spawned_at,
        ),
      });
    }
    return { teammates, agents: [...this.#agents.values()], workflows: [] };
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A teammate as the fold holds it: what the contract states about it, and the
 * two facts only the tree needs. */
interface Teammate {
  readonly status: Mutable<SessionTeammate>;
  agent_id?: string;
  team_name?: string;
}

interface PendingCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly at?: Timestamp;
}

/** How many unanswered calls are worth holding. A turn makes a handful; a
 * transcript read from its end can begin part-way through one, leaving calls
 * whose results were never in the window. */
const MAX_PENDING_CALLS = 256;

/** The file tools, and the argument each names its file with. Observed on the
 * harness's own calls rather than derived from a naming rule: a tool whose
 * argument happens to be a path is not thereby a file tool. */
const FILE_INPUT: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** The attachment kinds that carry a file, and the field the path is in. The
 * other kinds attach text the harness composed, which names no file. */
const ATTACHMENT_FILE: Record<string, string> = {
  edited_text_file: "filename",
  file: "filename",
};

/** How the harness wraps a teammate's message on its way into the session. */
const RELAY = /<teammate-message[^>]*\steammate_id="([^"]*)"[^>]*>([\s\S]*)/;

/** The opening of the message a teammate sends when it has nothing to do. */
const IDLE = '{"type":"idle_notification"';

/** How a result says the thing it started is still going rather than already
 * over: the call returned as soon as it was launched. A result that says
 * nothing at all means the same. */
function launched(status: string | undefined): boolean {
  return status === undefined || status === "async_launched";
}

/** Where a notification stops describing itself and starts quoting. */
function cut(content: string): number {
  let end = content.length;
  for (const opening of ["<summary>", "<event>", "<result>"]) {
    const at = content.indexOf(opening);
    if (at >= 0 && at < end) end = at;
  }
  return end;
}

function tagged(text: string, tag: string): string | undefined {
  return str(new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text)?.[1]);
}

/** A dependency list with what an update adds, in one order however either
 * side spelled it. */
function merge(before: readonly string[] | undefined, added: unknown): string[] {
  const all = new Set(before ?? []);
  if (Array.isArray(added)) {
    for (const each of added) {
      const id = str(each);
      if (id !== undefined) all.add(id);
    }
  }
  return [...all].sort();
}

/** One transcript record, as the ops that read a whole transcript need it.
 *
 * The fold above follows a file as it grows; a search, a dump and a fork sweep
 * read one that has stopped growing. Both are the same act of interpretation,
 * so both live here: nothing outside this module turns a transcript line into
 * meaning, and the harness's own spellings — its record types, its block
 * kinds, its ISO instants — stop at this boundary (§3.5). */
export interface TranscriptRecord {
  /** The record id a dump's bounds cut at. */
  readonly uuid?: string;
  readonly said_at?: Timestamp;
  /** Who said it, in the contract's two words. Absent for a record that is
   * neither side speaking — a title change, a summary, a harness note. */
  readonly said_by?: "user" | "agent";
  /** The words, with the thinking blocks kept apart so a dump can leave them
   * out without a second reading of the row. */
  readonly text?: string;
  readonly thinking?: string;
  /** A subagent's turn, interleaved into the session's own file. */
  readonly sidechain: boolean;
  /** Where the session ran, which the first records carry. */
  readonly cwd?: string;
  /** What `/rename` wrote, which is the only writer of a session's title. */
  readonly title?: string;
  /** What the turn ran as, in the transcript's own spelling. */
  readonly model?: string;
  readonly effort?: string;
}

/** Read one line. A line that is not a record — half-written, or not JSON at
 * all — yields nothing, the same way the fold skips it. */
export function readRecord(line: string): TranscriptRecord | undefined {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(row)) return undefined;
  const type = str(row["type"]);
  const rollout = rolloutRecord(row, type);
  if (rollout !== undefined) return rollout;
  const message = isRecord(row["message"]) ? row["message"] : undefined;
  const model = message === undefined ? undefined : str(message["model"]);
  return {
    sidechain: row["isSidechain"] === true,
    ...optional("uuid", str(row["uuid"])),
    ...optional("said_at", instant(row["timestamp"])),
    ...optional("said_by", saidBy(type)),
    ...optional("text", message === undefined ? undefined : blockText(message["content"])),
    ...optional("thinking", message === undefined ? undefined : thinkingText(message["content"])),
    ...optional("cwd", str(row["cwd"])),
    ...optional("title", type === "custom-title" ? str(row["customTitle"]) : undefined),
    ...optional("model", model === "<synthetic>" ? undefined : model),
    ...optional("effort", str(row["effort"])),
  };
}

/** One line of a Codex rollout, or nothing where the line is not one.
 *
 * A rollout says what kind of line it is in its own `type`, and the words it
 * uses appear in no Claude Code transcript — so the two formats are told apart
 * by the line rather than by anything the reader was told beforehand.
 *
 * What is read is what §5 asks a transcript for and a rollout answers: when a
 * person last spoke, and where the session runs. The rest of the fold's facts —
 * a session's todos, its teammates, the files it named — are Claude Code's own
 * records, and a Codex session simply declares none of them.
 *
 * `developer` is not a person: Codex writes the instructions a turn runs under
 * as messages of that role, so only `user` and `assistant` are read as somebody
 * speaking. One of the `user` rows is not a person either — Codex opens a
 * thread by stating the environment as `<environment_context>` — and it is the
 * fold that turns that away, by the same rule that turns away every injected
 * opening a Claude Code transcript carries: a row that opens with a tag is the
 * harness talking. So the role decides who is read here, and what is read
 * decides whether a person said it. */
function rolloutRecord(
  row: Record<string, unknown>,
  type: string | undefined,
): TranscriptRecord | undefined {
  if (type === "session_meta") {
    const payload = isRecord(row["payload"]) ? row["payload"] : undefined;
    return {
      sidechain: false,
      ...optional("said_at", instant(row["timestamp"])),
      ...optional("cwd", payload === undefined ? undefined : str(payload["cwd"])),
    };
  }
  if (type !== "response_item") return undefined;
  const payload = isRecord(row["payload"]) ? row["payload"] : undefined;
  if (payload === undefined || str(payload["type"]) !== "message") return { sidechain: false };
  const role = str(payload["role"]);
  return {
    sidechain: false,
    ...optional("said_at", instant(row["timestamp"])),
    ...optional<"said_by", "user" | "agent">(
      "said_by",
      role === "user" ? "user" : role === "assistant" ? "agent" : undefined,
    ),
    ...optional("text", blockText(payload["content"])),
  };
}

/** The harness's record types, in the contract's two words. Its `assistant` is
 * the contract's `agent`; every other type is a record neither side spoke. */
function saidBy(type: string | undefined): "user" | "agent" | undefined {
  if (type === "user") return "user";
  return type === "assistant" ? "agent" : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}

const TEXT_BLOCK = new Set(["text", "input_text", "output_text"]);

/** The text a message states, whoever wrote it. A plain prompt is a string; a
 * prompt with an attachment, and every row the harness writes, is a block
 * array whose text blocks carry the words. An array holding only tool results
 * yields nothing, which is what a tool answering looks like, and an error row
 * with several blocks reads as all of them rather than as its first line. */
function blockText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    // `text` is what Claude Code writes; `input_text` and `output_text` are
    // what a Codex rollout writes for the same thing, one per direction.
    if (!isRecord(block) || !TEXT_BLOCK.has(block["type"] as string)) continue;
    const text = str(block["text"]);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n").trim() || undefined;
}

/** The model's own reasoning, which a dump may be asked to leave out. Kept
 * apart from `text` rather than filtered out of it, so leaving it out is a
 * field the dump does not write rather than a second pass over the blocks. */
function thinkingText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "thinking") continue;
    const text = str(block["thinking"]);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n").trim() || undefined;
}

/** Openings observed on harness-written user rows that carry no marker of
 * their own. A person's prompt can begin with anything, so these are matched
 * against exactly rather than treated as a shape. */
const INJECTED_OPENINGS = [
  "<",
  "[SYSTEM NOTIFICATION - NOT USER INPUT]",
  "Another Claude session sent a message:",
];

function isHuman(text: string): boolean {
  return !INJECTED_OPENINGS.some((opening) => text.startsWith(opening));
}

/** A transcript instant, in the contract's spelling. The harness writes ISO
 * strings; the contract's `Timestamp` is Unix ms (§3.5). */
function instant(value: unknown): Timestamp | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
