import { bool, count, lines, list, optional, row, str } from "./record.ts";

/** What each tool's call and result are read as.
 *
 * The contract names fields for the tools worth reading closely and leaves
 * every other tool to a generic shape. Fields sharpen how a tool reads; they
 * never decide whether it is kept, so a tool absent from this table still
 * arrives carrying what it was called with and what it answered.
 *
 * A reader returns nothing when the record does not hold what the contract
 * requires of that shape — a `Bash` call with no command is not a `Bash` call
 * as the contract spells one — and the generic shape answers instead. That
 * keeps a malformed line from producing an item nothing can validate, without
 * losing the line. */
type Reader = (source: Record<string, unknown>) => Record<string, unknown> | undefined;

/** The call's own arguments, as the harness recorded them. */
const USE: Record<string, Reader> = {
  Bash: (input) => {
    const command = str(input["command"]);
    return command === undefined
      ? undefined
      : { command, ...optional("description", str(input["description"])) };
  },
  Read: (input) => {
    const file_path = str(input["file_path"]);
    return file_path === undefined
      ? undefined
      : {
          file_path,
          ...optional("offset", count(input["offset"])),
          ...optional("limit", count(input["limit"])),
        };
  },
  /** Bodies are counted, never carried: an edit's two sides are the file's
   * content, and a dump that inlined them would be the file. */
  Write: (input) => {
    const file_path = str(input["file_path"]);
    return file_path === undefined
      ? undefined
      : { file_path, ...optional("lines", lines(str(input["content"]))) };
  },
  Edit: (input) => {
    const file_path = str(input["file_path"]);
    return file_path === undefined
      ? undefined
      : {
          file_path,
          ...optional("old_lines", lines(str(input["old_string"]))),
          ...optional("new_lines", lines(str(input["new_string"]))),
        };
  },
  Grep: pattern,
  Glob: pattern,
  WebFetch: (input) => {
    const url = str(input["url"]);
    return url === undefined ? undefined : { url, ...optional("prompt", str(input["prompt"])) };
  },
  WebSearch: (input) => {
    const query = str(input["query"]);
    return query === undefined ? undefined : { query };
  },
  Agent: (input) => {
    const prompt = str(input["prompt"]);
    return prompt === undefined
      ? undefined
      : {
          prompt,
          ...optional("name", str(input["name"])),
          ...optional("subagent_type", str(input["subagent_type"])),
          ...optional("description", str(input["description"])),
        };
  },
  SendMessage: (input) => {
    const to = str(input["to"]);
    return to === undefined ? undefined : { to, ...optional("summary", str(input["summary"])) };
  },
  Monitor: (input) => {
    const description = str(input["description"]);
    return description === undefined
      ? undefined
      : {
          description,
          ...optional("command", str(input["command"])),
          ...optional("persistent", bool(input["persistent"])),
          ...optional("timeout_ms", count(input["timeout_ms"])),
        };
  },
  Skill: (input) => {
    const skill = str(input["skill"]);
    return skill === undefined ? undefined : { skill, ...optional("args", str(input["args"])) };
  },
  TodoWrite: (input) => {
    const todos = list(input["todos"]).flatMap((entry) => {
      const each = row(entry);
      const content = each === undefined ? undefined : str(each["content"]);
      const status = each === undefined ? undefined : str(each["status"]);
      return content === undefined || status === undefined ? [] : [{ content, status }];
    });
    return { todos };
  },
  TaskStop: (input) => {
    const task_id = str(input["task_id"]) ?? str(input["shell_id"]);
    return task_id === undefined ? undefined : { task_id };
  },
  CronCreate: (input) => {
    const cron = str(input["cron"]);
    return cron === undefined ? undefined : { cron, ...optional("prompt", str(input["prompt"])) };
  },
};

function pattern(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const found = str(input["pattern"]);
  return found === undefined
    ? undefined
    : { pattern: found, ...optional("path", str(input["path"])) };
}

/** What came back.
 *
 * The harness writes a tool's answer to `toolUseResult` in whatever shape that
 * tool settled on, so each reader knows one shape. `ok` stands where a tool
 * says nothing but whether it worked, and the block's own error flag is what
 * decides it. */
const RESULT: Record<string, (result: unknown, failed: boolean) => Record<string, unknown>> = {
  Bash: (result) => {
    const fields = row(result);
    if (fields === undefined) return { ...optional("stdout", str(result)) };
    return {
      ...optional("stdout", str(fields["stdout"])),
      ...optional("stderr", str(fields["stderr"])),
      ...optional("interrupted", bool(fields["interrupted"])),
    };
  },
  Read: (result) => {
    const fields = row(result);
    const file = fields === undefined ? undefined : row(fields["file"]);
    const content = file === undefined ? undefined : str(file["content"]);
    return {
      ...optional(
        "lines",
        file === undefined ? undefined : (count(file["numLines"]) ?? lines(content)),
      ),
      ...optional("bytes", content === undefined ? undefined : Buffer.byteLength(content)),
    };
  },
  Write: (_result, failed) => ({ ok: !failed }),
  Edit: (_result, failed) => ({ ok: !failed }),
  Grep: matches,
  Glob: matches,
  WebFetch: (result) => {
    const fields = row(result);
    return {
      ...optional(
        "text",
        str(result) ?? (fields === undefined ? undefined : str(fields["result"])),
      ),
    };
  },
  WebSearch: (result) => {
    const fields = row(result);
    if (fields === undefined || !Array.isArray(fields["results"])) return {};
    return { results: fields["results"].length };
  },
  Agent: (result) => {
    const fields = row(result) ?? {};
    return {
      ...optional("agent_id", str(fields["agentId"]) ?? str(fields["agent_id"])),
      ...optional("status", str(fields["status"])),
    };
  },
  SendMessage: (result) => {
    const fields = row(result) ?? {};
    return {
      ...optional("msg_id", str(fields["msg_id"])),
      ...optional("routing", str(fields["routing"])),
    };
  },
  Monitor: (result) => {
    const fields = row(result) ?? {};
    return { ...optional("task_id", str(fields["taskId"]) ?? str(fields["task_id"])) };
  },
  Skill: (result) => {
    const fields = row(result) ?? {};
    return {
      ...optional("agent_id", str(fields["agentId"]) ?? str(fields["agent_id"])),
      ...optional("background", bool(fields["background"])),
      ...optional("status", str(fields["status"])),
    };
  },
  TodoWrite: (_result, failed) => ({ ok: !failed }),
  TaskStop: (_result, failed) => ({ ok: !failed }),
  CronCreate: (result) => {
    const fields = row(result) ?? {};
    return { ...optional("cron_id", str(fields["cron_id"]) ?? str(fields["id"])) };
  },
};

function matches(result: unknown): Record<string, unknown> {
  const fields = row(result);
  if (fields === undefined) return {};
  const found = count(fields["numFiles"]) ?? count(fields["numLines"]);
  return { ...optional("matches", found) };
}

/** The fields of one tool call, or nothing where the generic shape should
 * answer for it. */
export function useFields(name: string, input: unknown): Record<string, unknown> | undefined {
  const reader = USE[name];
  const fields = row(input) ?? {};
  return reader === undefined ? undefined : reader(fields);
}

export function resultFields(
  name: string | undefined,
  result: unknown,
  failed: boolean,
): Record<string, unknown> | undefined {
  const reader = name === undefined ? undefined : RESULT[name];
  return reader === undefined ? undefined : reader(result, failed);
}

/** Whatever a tool answered, for a tool nothing knows the shape of. A string
 * answer becomes one field rather than being dropped for not being an
 * object. */
export function genericResult(result: unknown): Record<string, unknown> {
  const fields = row(result);
  if (fields !== undefined) return fields;
  const text = str(result);
  return text === undefined ? {} : { text };
}
