/** What a harness lifecycle event tells the command it fires.
 *
 * The harness writes one JSON object to the command's standard input, and only
 * the fields a greeting or a departure is made of are taken from it. The names
 * are the harness's own (`session_id`, `cwd`, `transcript_path`, `reason`);
 * they are read here and nowhere else, so the rest of the CLI speaks the
 * contract's names. */
export interface HookEvent {
  readonly sid?: string;
  readonly cwd?: string;
  readonly transcript_path?: string;
  readonly reason?: string;
}

/** Read one such event, or nothing to go on.
 *
 * A hook runs beside a session rather than for a person, so nothing it is
 * handed is an error: input that is absent, truncated or not an object leaves
 * the command with whatever its own options gave it. What the command does
 * with nothing is the command's decision, and for every command that reads one
 * that decision is to stay quiet. */
export async function hookEvent(
  read: () => Promise<string> = () => Bun.stdin.text(),
): Promise<HookEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await read());
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const event = parsed as Record<string, unknown>;
  return {
    ...text(event, "session_id", "sid"),
    ...text(event, "cwd", "cwd"),
    ...text(event, "transcript_path", "transcript_path"),
    ...text(event, "reason", "reason"),
  };
}

function text(
  event: Record<string, unknown>,
  from: string,
  as: keyof HookEvent,
): Partial<HookEvent> {
  const value = event[from];
  return typeof value === "string" && value !== "" ? { [as]: value } : {};
}
