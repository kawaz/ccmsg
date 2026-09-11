import type {
  InstanceId,
  LlmStatusComponent,
  LlmStatusIncident,
  LlmStatusObserved,
  LlmStatusObservedState,
  LlmStatusOfficial,
  LlmStatusOfficialState,
  LlmStatusReport,
  LlmStatusService,
  LlmStatusSeverity,
} from "@ccmsg/protocol";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";
import {
  fetchJson,
  objectOf,
  oneOf,
  optionalInstant,
  optionalInteger,
  optionalText,
} from "./json.ts";

/** How long the read is given. The gateway answers from a snapshot it keeps,
 * so a read that takes longer than this is one that is not coming. */
const TIMEOUT_MS = 10_000;

/** Cap on the document. A report names the services behind one gateway; past
 * this it is not one, and the whole of it is held in memory to be parsed. */
const MAX_BYTES = 1024 * 1024;

/** How long the trouble a request event reports is left to settle before the
 * report is re-read.
 *
 * A single upstream failure arrives as a burst — several routes are tried and
 * each refusal is its own event — and the gateway is refreshing its own
 * sources on the same trigger. Reading once after the burst gets one answer
 * that has had a moment to become true, instead of one read per refusal. */
const TROUBLE_SETTLE_MS = 5_000;

/** The HTTP statuses that say the trouble is upstream's rather than this
 * request's. Quota and credential refusals are a different report's subject
 * (they reach a client as that credential's error), and a plain 5xx can be
 * synthesised anywhere along the way — the gateway itself only treats an
 * overload as a service signal, and neither does this. */
function isUpstreamTrouble(status: number | undefined): boolean {
  return status === 529;
}

export interface LlmStatusDeps {
  readonly self: InstanceId;
  /** Where the gateway answers, already joined to its status path. */
  readonly url: string;
  readonly publish: (topic: string, data: unknown) => void;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Replaces the fetch and the delay in tests. */
  readonly fetch?: typeof fetch;
  readonly settleMs?: number;
}

/** The gateway's report on the services behind it.
 *
 * `per_instance_whole` (§6.2): a frame replaces what this instance last said
 * and leaves other instances' reports alone, because the report is one document
 * the gateway behind this instance assembles and half of it means nothing on
 * its own.
 *
 * It is read at two moments and no others (M3): when someone starts listening,
 * and once after a request event says an upstream refused. There is no poll —
 * a report only changes when something upstream did, and a request event is
 * this instance being told exactly that. */
export class LlmStatus implements UpstreamResource {
  #report: LlmStatusReport | undefined;
  #reading: Promise<void> | undefined;
  #settling: ReturnType<typeof setTimeout> | undefined;
  #listening = false;

  constructor(private readonly deps: LlmStatusDeps) {}

  /** A request the gateway forwarded says an upstream refused it. The read is
   * deferred, and a second refusal inside the same window joins the first
   * rather than starting its own. */
  noteRequestStatus(status: number | undefined): void {
    if (!isUpstreamTrouble(status) || !this.#listening || this.#settling !== undefined) return;
    this.#settling = setTimeout(() => {
      this.#settling = undefined;
      void this.read();
    }, this.deps.settleMs ?? TROUBLE_SETTLE_MS);
    // The instance must be able to leave while this is pending (§8.5).
    this.#settling.unref?.();
  }

  /** Read the report and state it. Two callers at once share one read: the
   * answer is the same document, and asking the gateway twice for it is what
   * a burst of refusals would otherwise do. */
  async read(): Promise<void> {
    this.#reading ??= this.#read().finally(() => {
      this.#reading = undefined;
    });
    await this.#reading;
  }

  // --- UpstreamResource (§6.3)

  start(): void {
    this.#listening = true;
    void this.read();
  }

  stop(): void {
    this.#listening = false;
    if (this.#settling !== undefined) clearTimeout(this.#settling);
    this.#settling = undefined;
  }

  /** What is held, if anything has been read. A subscriber that arrives before
   * the first read gets nothing and then the report, rather than an empty
   * report it would show as "every service unknown". */
  snapshot(): readonly TopicValue[] {
    if (this.#report === undefined) return [];
    return [{ instance: this.deps.self, data: this.#report }];
  }

  async #read(): Promise<void> {
    let document: unknown;
    try {
      document = await fetchJson(this.deps.url, {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch }),
      });
    } catch (cause) {
      // The last good report is kept: a read that failed says nothing about
      // the services, and replacing what is known with nothing would blank the
      // display over this instance's own trouble.
      this.deps.log?.("could not read the gateway's status", { error: String(cause) });
      return;
    }
    const report = reportOf(document);
    if (report === undefined) {
      this.deps.log?.("the gateway's status could not be understood");
      return;
    }
    this.#report = report;
    this.deps.publish("llm.status", report);
  }
}

const SEVERITIES: readonly LlmStatusSeverity[] = ["ok", "warning", "critical", "unknown"];
const OFFICIAL_STATES: readonly LlmStatusOfficialState[] = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
  "unknown",
];
const OBSERVED_STATES: readonly LlmStatusObservedState[] = ["reachable", "failing", "unknown"];

/** Read the gateway's document as this contract's report (§3.5).
 *
 * The gateway already answers in Unix ms under these names, so nothing is
 * converted — but nothing is passed through unread either: every field is
 * taken only at the type the contract states, and each closed vocabulary is
 * checked against its own set. A word outside one arrives as `unknown` rather
 * than as itself, which is what keeps a future vocabulary from reaching a
 * screen as something nothing can draw. The verdict itself is never
 * recomputed: the gateway knows which of its two signals outweighs the other,
 * and a second opinion here would disagree with every other reader of the same
 * report. */
export function reportOf(value: unknown): LlmStatusReport | undefined {
  const raw = objectOf(value);
  if (raw === undefined) return undefined;
  const overall = objectOf(raw["overall"]);
  const services = raw["services"];
  if (overall === undefined || !Array.isArray(services)) return undefined;
  return {
    ...optionalInteger("schema_version", raw["schema_version"]),
    ...optionalInstant("generated_at", raw["generated_at"]),
    overall: {
      severity: oneOf(SEVERITIES, overall["severity"], "unknown"),
      service_counts: countsOf(overall["service_counts"]),
    },
    services: services.flatMap((service) => serviceOf(service) ?? []),
  };
}

function serviceOf(value: unknown): LlmStatusService | undefined {
  const raw = objectOf(value);
  if (raw === undefined) return undefined;
  const id = raw["id"];
  const name = raw["name"];
  if (typeof id !== "string" || typeof name !== "string") return undefined;
  const routes = raw["routes"];
  const official = officialOf(raw["official"]);
  const observed = observedOf(raw["observed"]);
  return {
    id,
    name,
    severity: oneOf(SEVERITIES, raw["severity"], "unknown"),
    routes: Array.isArray(routes) ? routes.filter((route) => typeof route === "string") : [],
    ...(official === undefined ? {} : { official }),
    ...(observed === undefined ? {} : { observed }),
  };
}

function officialOf(value: unknown): LlmStatusOfficial | undefined {
  const raw = objectOf(value);
  if (raw === undefined) return undefined;
  const components = raw["components"];
  const incidents = raw["incidents"];
  return {
    state: oneOf(OFFICIAL_STATES, raw["state"], "unknown"),
    ...optionalText("source", raw["source"]),
    ...optionalText("source_url", raw["source_url"]),
    ...optionalInstant("observed_at", raw["observed_at"]),
    ...(typeof raw["stale"] === "boolean" ? { stale: raw["stale"] } : {}),
    components: Array.isArray(components) ? components.flatMap((c) => componentOf(c) ?? []) : [],
    incidents: Array.isArray(incidents) ? incidents.flatMap((i) => incidentOf(i) ?? []) : [],
    ...optionalText("error", raw["error"]),
  };
}

function componentOf(value: unknown): LlmStatusComponent | undefined {
  const raw = objectOf(value);
  if (raw === undefined || typeof raw["name"] !== "string") return undefined;
  return {
    ...optionalText("id", raw["id"]),
    name: raw["name"],
    state: oneOf(OFFICIAL_STATES, raw["state"], "unknown"),
  };
}

/** One incident. Everything but its title is optional — a line with a title
 * alone is still worth showing — and all of it is the provider's own prose,
 * carried as text for a display that must never read it as markup. */
function incidentOf(value: unknown): LlmStatusIncident | undefined {
  const raw = objectOf(value);
  if (raw === undefined || typeof raw["name"] !== "string") return undefined;
  return {
    ...optionalText("id", raw["id"]),
    name: raw["name"],
    ...optionalText("state", raw["state"]),
    ...optionalText("impact", raw["impact"]),
    ...optionalInstant("created_at", raw["created_at"]),
    ...optionalInstant("updated_at", raw["updated_at"]),
    ...optionalText("url", raw["url"]),
    ...optionalText("latest_update", raw["latest_update"]),
    ...optionalText("scope", raw["scope"]),
  };
}

function observedOf(value: unknown): LlmStatusObserved | undefined {
  const raw = objectOf(value);
  if (raw === undefined) return undefined;
  const failure = objectOf(raw["last_failure"]);
  return {
    state: oneOf(OBSERVED_STATES, raw["state"], "unknown"),
    ...optionalInstant("observed_at", raw["observed_at"]),
    ...optionalInstant("expires_at", raw["expires_at"]),
    ...optionalInstant("last_success_at", raw["last_success_at"]),
    ...(failure === undefined
      ? {}
      : {
          last_failure: {
            ...optionalInstant("at", failure["at"]),
            ...optionalText("kind", failure["kind"]),
            ...optionalInteger("status", failure["status"]),
          },
        }),
  };
}

function countsOf(value: unknown): Record<string, number> {
  const raw = objectOf(value);
  if (raw === undefined) return {};
  const counts: Record<string, number> = {};
  for (const [name, count] of Object.entries(raw)) {
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) counts[name] = count;
  }
  return counts;
}
