import type { TranslateResult, TranslateRunArgs, TranslateRunResult } from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../dispatch/index.ts";
import { type HelperChannel, spawnHelper } from "./helper.ts";

/** How long one batch may take before the helper is assumed wedged.
 *
 * The deadline grows with the input because the work does: a sentence comes
 * back in seconds and a page takes minutes. The helper reports no progress, so
 * a batch that outlives its deadline can only be ended by ending the helper —
 * the next call starts a fresh one. */
const BASE_MS = 10_000;
const PER_100_CHARS_MS = 1_000;
const MAX_MS = 120_000;

export function deadlineMs(chars: number): number {
  return Math.min(MAX_MS, BASE_MS + Math.ceil(chars / 100) * PER_100_CHARS_MS);
}

export interface TranslateDeps {
  /** Starts the helper. Replaced in tests, which answer the same line protocol
   * without a program on the host. */
  readonly start?: () => HelperChannel;
  readonly deadlineMs?: (chars: number) => number;
}

/** The host's translator, kept running between calls.
 *
 * Resident because starting it is the expensive part (DR-0023 §3.1): the
 * process loads a translation session once and answers from it, so a batch per
 * process would pay that cost on every keystroke's worth of text. One batch is
 * in flight at a time — the helper answers one line per line it is given, and
 * two batches sharing that channel could not tell the answers apart. */
export class Translate {
  #helper: HelperChannel | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #next = 0;

  constructor(
    private readonly helperPath: string,
    private readonly deps: TranslateDeps = {},
  ) {}

  async run(args: TranslateRunArgs): Promise<TranslateRunResult> {
    // Nothing to translate needs no helper, and starting one to answer with an
    // empty list would make the empty batch the probe it is not.
    if (args.texts.length === 0) return { results: [] };
    const done = this.#queue.then(
      () => this.#exchange(args.texts),
      () => this.#exchange(args.texts),
    );
    this.#queue = done.catch(() => undefined);
    return { results: await done };
  }

  /** Stop the helper. What shutdown calls, and what a wedged batch does before
   * it gives up. */
  stop(): void {
    this.#helper?.kill();
    this.#helper = undefined;
  }

  async #exchange(texts: readonly string[]): Promise<TranslateResult[]> {
    const helper = (this.#helper ??= (this.deps.start ?? (() => spawnHelper(this.helperPath)))());
    const id = `${(this.#next += 1)}`;
    const chars = texts.reduce((total, text) => total + text.length, 0);
    const budget = (this.deps.deadlineMs ?? deadlineMs)(chars);
    let expired: ReturnType<typeof setTimeout> | undefined;
    try {
      await helper.write(`${JSON.stringify({ id, texts })}\n`);
      const line = await Promise.race([
        helper.read(),
        new Promise<never>((_resolve, reject) => {
          expired = setTimeout(() => {
            reject(new Error(`the helper did not answer within ${budget}ms`));
          }, budget);
        }),
      ]);
      if (line === undefined) throw new Error("the helper stopped before it answered");
      return read(line, id, texts.length);
    } catch (cause) {
      // Whatever went wrong, this helper is no longer known to be in step with
      // the line protocol, so it is ended and the next call starts a fresh one.
      this.stop();
      throw new OpError(
        "translate_helper_failed",
        `the translation helper failed: ${String(cause)}`,
      );
    } finally {
      if (expired !== undefined) clearTimeout(expired);
    }
  }
}

/** One answer line, read as the batch it was meant to answer.
 *
 * The id and the count are both checked: an answer to another batch, or one
 * holding a different number of results, would hand the caller texts that are
 * not the ones it sent. */
function read(line: string, id: string, expected: number): TranslateResult[] {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null) throw new Error("the answer is not an object");
  const fields = parsed as Record<string, unknown>;
  if (fields["id"] !== id) throw new Error(`the answer names batch ${String(fields["id"])}`);
  const results = fields["results"];
  if (!Array.isArray(results) || results.length !== expected) {
    throw new Error(
      `the answer holds ${Array.isArray(results) ? results.length : 0} of ${expected}`,
    );
  }
  return results.map((entry): TranslateResult => {
    const item = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const text = item["text"];
    if (item["ok"] === true && typeof text === "string") return { ok: true, text };
    const error = item["error"];
    return { ok: false, error: typeof error === "string" ? error : "the helper stated no reason" };
  });
}

export function translateHandlers(translate: Translate) {
  return {
    translate_run: (input: HandlerInput): Promise<TranslateRunResult> =>
      translate.run(input.args as unknown as TranslateRunArgs),
  };
}
