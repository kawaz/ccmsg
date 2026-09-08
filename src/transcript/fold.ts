import type { SessionApiError, Timestamp } from "@ccmsg/protocol";

/** Everything one session's transcript is folded into (§3.3).
 *
 * One fold, not one per consumer: the same line settles whether the session is
 * stopped and when a person last spoke to it, so it is read once and every
 * value it can settle is settled from that read (M5). Both fields are absent
 * until a line says otherwise, which is also what a transcript that has not
 * been read yet looks like. */
export interface TranscriptFacts {
  /** The error the latest turn ended on. Present only while it stands: a real
   * turn after it clears it, so this is the session's current state and not
   * every error it ever hit. One of the two things §5.2 calls Waiting. */
  readonly api_error?: SessionApiError;
  /** When a person last put something into the session (§5.3). */
  readonly last_user_input_at?: Timestamp;
}

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

  get facts(): TranscriptFacts {
    return {
      ...(this.#apiError === undefined ? {} : { api_error: this.#apiError }),
      ...(this.#lastUserInputAt === undefined ? {} : { last_user_input_at: this.#lastUserInputAt }),
    };
  }

  reset(): void {
    this.#apiError = undefined;
    this.#lastUserInputAt = undefined;
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
    // Every value this fold derives, derived from the one parse (M5).
    let changed = this.#foldApiError(row);
    if (this.#foldUserInput(row)) changed = true;
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
}

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
    if (!isRecord(block) || block["type"] !== "text") continue;
    const text = str(block["text"]);
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
