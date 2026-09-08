import type {
  LlmStatsDay,
  LlmStatsModelUsage,
  LlmStatsReadArgs,
  LlmStatsReadResult,
} from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import { fetchJson, objectOf, optionalInstant, optionalInteger, optionalNumber } from "./json.ts";
import { withQuery } from "./usage.ts";

/** A year of daily spend across every credential and model is a few hundred
 * kilobytes; this leaves room for a busier host without letting a misconfigured
 * address stream this instance out of memory. */
const MAX_BYTES = 4 * 1024 * 1024;

/** Wider than the quota read's: this document is assembled over a range the
 * caller chose, so a year is legitimately slower than a snapshot. */
const TIMEOUT_MS = 30_000;

export interface StatsDeps {
  /** Where the gateway answers, already joined to its stats path. */
  readonly url: string;
  readonly fetch?: typeof fetch;
}

/** Ask the gateway what the host's credentials have cost, by day. */
export async function readStats(
  deps: StatsDeps,
  args: LlmStatsReadArgs,
): Promise<LlmStatsReadResult> {
  // A window the caller did not name is the gateway's own to choose.
  const url = args.days === undefined ? deps.url : withQuery(deps.url, "days", String(args.days));
  let document: unknown;
  try {
    document = await fetchJson(url, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  } catch (cause) {
    throw new OpError("internal_error", `the gateway's spend could not be read: ${String(cause)}`);
  }
  const stats = statsOf(document);
  if (stats === undefined) {
    throw new OpError("internal_error", "the gateway's spend could not be understood");
  }
  return stats;
}

/** Read the gateway's document as this contract's answer (§3.5). The dates are
 * the gateway's own keys and are not reinterpreted: a day here means whatever
 * it means there. */
export function statsOf(value: unknown): LlmStatsReadResult | undefined {
  const raw = objectOf(value);
  const rawDays = objectOf(raw?.["days"]);
  if (raw === undefined || rawDays === undefined) return undefined;
  const days: Record<string, LlmStatsDay> = {};
  for (const [date, entry] of Object.entries(rawDays)) {
    const day = dayOf(entry);
    if (day !== undefined) days[date] = day;
  }
  return { ...optionalInstant("generated_at", raw["generated_at"]), days };
}

/** A day whose credentials cannot be read still renders as a day with its
 * total, which says more than a hole in the series would. */
function dayOf(value: unknown): LlmStatsDay | undefined {
  const raw = objectOf(value);
  if (raw === undefined) return undefined;
  const credentials: Record<string, Record<string, LlmStatsModelUsage>> = {};
  const rawCredentials = objectOf(raw["credentials"]);
  for (const [name, rawModels] of Object.entries(rawCredentials ?? {})) {
    const models = objectOf(rawModels);
    if (models === undefined) continue;
    const byModel: Record<string, LlmStatsModelUsage> = {};
    for (const [model, entry] of Object.entries(models)) {
      const usage = modelUsageOf(entry);
      if (usage !== undefined) byModel[model] = usage;
    }
    credentials[name] = byModel;
  }
  return { credentials, ...optionalNumber("total_usd", raw["total_usd"]) };
}

/** Every counter is optional and absent when it was not reported: a counter a
 * display sums has to be a number or nothing, never a zero something else
 * would then add up. */
function modelUsageOf(value: unknown): LlmStatsModelUsage | undefined {
  const raw = objectOf(value);
  if (raw === undefined) return undefined;
  return {
    ...optionalInteger("requests", raw["requests"]),
    ...optionalInteger("input_tokens", raw["input_tokens"]),
    ...optionalInteger("output_tokens", raw["output_tokens"]),
    ...optionalInteger("cache_creation_input_tokens", raw["cache_creation_input_tokens"]),
    ...optionalInteger("cache_read_input_tokens", raw["cache_read_input_tokens"]),
    ...optionalNumber("usd", raw["usd"]),
  };
}
