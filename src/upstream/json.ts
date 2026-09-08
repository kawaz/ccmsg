import type { Timestamp } from "@ccmsg/protocol";

/** What every read of an upstream document is built from (§3.5).
 *
 * The gateway's three documents are read the same way — a field is taken only
 * at the type this contract states for it, and anything else is absent — so the
 * readers live here once rather than once per document. */

export interface FetchOptions {
  /** How long the read is given before it is one that is not coming. */
  readonly timeoutMs: number;
  /** Cap on the document, since the whole of it is held to be parsed. */
  readonly maxBytes: number;
  /** Replaces the outward read in tests. */
  readonly fetch?: typeof fetch;
}

/** One JSON document from the gateway, or a throw saying why not. */
export async function fetchJson(url: string, options: FetchOptions): Promise<unknown> {
  const call = options.fetch ?? fetch;
  const answer = await call(url, {
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!answer.ok) throw new Error(`the gateway answered ${answer.status}`);
  return JSON.parse(await bounded(answer, options.maxBytes)) as unknown;
}

async function bounded(answer: Response, maxBytes: number): Promise<string> {
  const body = answer.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`the document is over ${maxBytes} bytes`);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

export function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function optionalText(name: string, value: unknown): Record<string, string> {
  return typeof value === "string" ? { [name]: value } : {};
}

export function optionalInteger(name: string, value: unknown): Record<string, number> {
  return typeof value === "number" && Number.isInteger(value) ? { [name]: value } : {};
}

export function optionalNumber(name: string, value: unknown): Record<string, number> {
  return typeof value === "number" && Number.isFinite(value) ? { [name]: value } : {};
}

export function optionalFlag(name: string, value: unknown): Record<string, boolean> {
  return typeof value === "boolean" ? { [name]: value } : {};
}

/** An instant, taken only as a number. Rejecting a string is what stops an ISO
 * time from travelling on a field this contract says is Unix ms. */
export function optionalInstant(name: string, value: unknown): Record<string, Timestamp> {
  return typeof value === "number" && Number.isFinite(value) ? { [name]: value } : {};
}
