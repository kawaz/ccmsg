import type {
  LlmUsageAuth,
  LlmUsageCredential,
  LlmUsageLimit,
  LlmUsageOverage,
  LlmUsageReadArgs,
  LlmUsageReadResult,
  LlmUsageSnapshot,
  LlmUsageWindow,
} from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import {
  fetchJson,
  objectOf,
  optionalFlag,
  optionalInstant,
  optionalInteger,
  optionalText,
} from "./json.ts";

/** A handful of credentials. Past this the address is pointing at something
 * else entirely, and the whole document is held to be parsed. */
const MAX_BYTES = 1024 * 1024;

/** The gateway answers a cached read from a snapshot it keeps. */
const TIMEOUT_MS = 10_000;

/** A probe waits on every provider in turn rather than on the gateway's own
 * cache, so it is legitimately slower — wide enough that one slow provider does
 * not lose the whole answer. */
const PROBE_TIMEOUT_MS = 60_000;

export interface UsageDeps {
  /** Where the gateway answers, already joined to its usage path. */
  readonly url: string;
  readonly fetch?: typeof fetch;
}

/** Ask the gateway what quota each credential has left.
 *
 * A failed read is the op's failure, unlike the status report's: there is no
 * last-good reading held here to fall back on, and answering with an empty list
 * of credentials would read as "this host has none". */
export async function readUsage(
  deps: UsageDeps,
  args: LlmUsageReadArgs,
): Promise<LlmUsageReadResult> {
  const refresh = args.refresh === true;
  const url = refresh ? withQuery(deps.url, "refresh", "true") : deps.url;
  let document: unknown;
  try {
    document = await fetchJson(url, {
      timeoutMs: refresh ? PROBE_TIMEOUT_MS : TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  } catch (cause) {
    throw new OpError("internal_error", `the gateway's usage could not be read: ${String(cause)}`);
  }
  const usage = usageOf(document, deps.url);
  if (usage === undefined) {
    throw new OpError("internal_error", "the gateway's usage could not be understood");
  }
  return usage;
}

/** Read the gateway's document as this contract's answer (DESIGN §2.4).
 *
 * The names that differ are the two the gateway spells its own way — `reset`
 * and `window_seconds` — and both are already Unix ms and seconds, so the
 * conversion is the name alone. Everything else is taken at the type this
 * contract states and is otherwise absent: an open vocabulary travels as sent,
 * because a verdict this daemon does not recognise has to reach the screen as
 * itself. */
export function usageOf(value: unknown, base?: string): LlmUsageReadResult | undefined {
  const raw = objectOf(value);
  if (raw === undefined || !Array.isArray(raw["credentials"])) return undefined;
  return {
    ...optionalInstant("generated_at", raw["generated_at"]),
    credentials: raw["credentials"].flatMap((entry) => credentialOf(entry, base) ?? []),
  };
}

/** A credential with no name cannot be told from its neighbours, so it is
 * dropped; every other field degrades to absent and the row still renders. */
function credentialOf(value: unknown, base?: string): LlmUsageCredential | undefined {
  const raw = objectOf(value);
  const name = raw?.["name"];
  if (raw === undefined || typeof name !== "string") return undefined;
  const auth = authOf(raw["auth"], base);
  const snapshot = snapshotOf(raw["snapshot"]);
  const limits = Array.isArray(raw["limits"])
    ? raw["limits"].flatMap((limit) => limitOf(limit) ?? [])
    : [];
  return {
    name,
    ...optionalText("type", raw["type"]),
    support: typeof raw["support"] === "string" ? raw["support"] : "unknown",
    ...(auth === undefined ? {} : { auth }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(limits.length === 0 ? {} : { limits }),
    ...optionalText("probe_error", raw["probe_error"]),
  };
}

/** Only `status` is required: a reading with no word for what it is would have
 * to be shown as a state this daemon invented. */
function authOf(value: unknown, base?: string): LlmUsageAuth | undefined {
  const raw = objectOf(value);
  const status = raw?.["status"];
  if (raw === undefined || typeof status !== "string") return undefined;
  const login = loginUrl(raw["login_path"], base);
  return {
    status,
    ...optionalText("reason", raw["reason"]),
    ...optionalInstant("observed_at", raw["observed_at"]),
    ...(login === undefined ? {} : { login_url: login }),
  };
}

/** The gateway states a path rather than an address, because it does not know
 * the one it is published under. It is resolved against the endpoint this
 * instance fetched from, and only that origin is kept.
 *
 * Design rationale: the link is rendered in a person's browser, so a gateway —
 * or something answering in its place — that named another host would be
 * planting a "log in here" button pointing off it. Dropping such a link costs a
 * button; following one could cost a credential. */
function loginUrl(path: unknown, base?: string): string | undefined {
  if (typeof path !== "string" || base === undefined) return undefined;
  try {
    const origin = new URL(base);
    const resolved = new URL(path, origin);
    return resolved.origin === origin.origin ? resolved.toString() : undefined;
  } catch {
    return undefined;
  }
}

function overageOf(value: unknown): LlmUsageOverage | undefined {
  const raw = objectOf(value);
  const status = raw?.["status"];
  if (raw === undefined || typeof status !== "string") return undefined;
  return { status, ...optionalText("disabled_reason", raw["disabled_reason"]) };
}

/** The windows are the snapshot's own keys, beside the two fields that are not
 * windows. Read by shape rather than against a list of names, so a provider
 * that starts reporting a third window needs no change here — and an unrelated
 * key is dropped instead of drawn as an empty bar. */
function snapshotOf(value: unknown): LlmUsageSnapshot | undefined {
  const raw = objectOf(value);
  if (raw === undefined) return undefined;
  const windows: Record<string, LlmUsageWindow> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "observed_at" || name === "overage") continue;
    const window = windowOf(entry);
    if (window !== undefined) windows[name] = window;
  }
  const overage = overageOf(raw["overage"]);
  return {
    ...optionalInstant("observed_at", raw["observed_at"]),
    ...(overage === undefined ? {} : { overage }),
    windows,
  };
}

function windowOf(value: unknown): LlmUsageWindow | undefined {
  const raw = objectOf(value);
  const utilization = raw?.["utilization"];
  const status = raw?.["status"];
  if (raw === undefined || typeof utilization !== "number" || typeof status !== "string") {
    return undefined;
  }
  return {
    utilization,
    status,
    ...optionalInstant("reset_at", raw["reset"]),
    ...optionalInteger("window_secs", raw["window_seconds"]),
    ...optionalFlag("expired", raw["expired"]),
  };
}

/** Recognised by shape like a window: an entry counts as a limit when it names
 * what it limits and states a figure for it. */
function limitOf(value: unknown): LlmUsageLimit | undefined {
  const raw = objectOf(value);
  const kind = raw?.["kind"];
  const percent = raw?.["percent"];
  if (raw === undefined || typeof kind !== "string" || typeof percent !== "number") {
    return undefined;
  }
  return {
    kind,
    percent,
    severity: typeof raw["severity"] === "string" ? raw["severity"] : "unknown",
    ...optionalInstant("resets_at", raw["resets_at"]),
    ...optionalText("model", raw["model"]),
    ...optionalFlag("is_active", raw["is_active"]),
    ...optionalInteger("window_secs", raw["window_seconds"]),
  };
}

export function withQuery(base: string, name: string, value: string): string {
  const url = new URL(base);
  url.searchParams.set(name, value);
  return url.toString();
}
