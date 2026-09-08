import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  Capability,
  InstanceId,
  LlmStatsReadArgs,
  LlmStatsReadResult,
  LlmUsageReadArgs,
  LlmUsageReadResult,
  Sid,
  Timestamp,
} from "@ccmsg/protocol";
import type { HandlerInput } from "../dispatch/index.ts";
import { ConfigError, type UpstreamConfig } from "../instance/config.ts";
import type { Env } from "../instance/paths.ts";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";
import { parseGatewayItem } from "./events.ts";
import { LlmRequests } from "./requests.ts";
import { readStats } from "./stats.ts";
import { LlmStatus } from "./status.ts";
import { readUsage } from "./usage.ts";
import { handleWebhook, SOURCE_NAME, type WebhookSource } from "./webhook.ts";

/** Where the gateway's own endpoints live under its address (DR-0006). */
const STATUS_PATH = "/llm-gateway/status";
const USAGE_PATH = "/llm-gateway/usage";
const STATS_PATH = "/llm-gateway/stats";

/** What the config says this instance can reach of the gateway, resolved.
 *
 * Both halves are independent: an instance can be posted to without being able
 * to ask anything back, and the other way round. Each grants its own
 * capability, so a client is told which of the two it has rather than
 * discovering it by subscribing. */
export interface GatewaySetup {
  /** Present when a webhook source is configured, with the secret it must
   * present already read. */
  readonly source?: { readonly name: string; readonly token: string };
  /** Present when the gateway's address is configured. The three are one
   * decision — the address — and are resolved together so a client is told
   * about all three at once rather than discovering each by asking. */
  readonly statusUrl?: string;
  readonly usageUrl?: string;
  readonly statsUrl?: string;
}

/** Read the upstream section (§8.2).
 *
 * A setting that is there and cannot be honoured ends the start rather than
 * leaving the feature it asked for silently off (DV-Q9): an operator who named
 * a webhook source wants the route, and an instance that came up without it
 * looks identical to one nobody is posting to. A section that is absent is not
 * broken — it states that this instance has no gateway, which costs the rows
 * one attribute and nothing else (§5.2). */
export function gatewaySetup(config: UpstreamConfig, file: string, env: Env): GatewaySetup {
  const name = config.gateway_webhook_source;
  const url = config.gateway_url;
  return {
    ...(name === undefined
      ? {}
      : { source: { name: sourceName(file, name), token: token(file, config, env, name) } }),
    ...(url === undefined
      ? {}
      : {
          statusUrl: endpoint(file, url, STATUS_PATH),
          usageUrl: endpoint(file, url, USAGE_PATH),
          statsUrl: endpoint(file, url, STATS_PATH),
        }),
  };
}

/** The capabilities the setup grants. `llm_events` says request activity
 * arrives to be pushed; the other three say the gateway can be asked for its
 * report, its quota and its spend. */
export function gatewayCapabilities(setup: GatewaySetup): Capability[] {
  return [
    ...(setup.source === undefined ? [] : (["llm_events"] as const)),
    ...(setup.statusUrl === undefined ? [] : (["llm_status"] as const)),
    ...(setup.usageUrl === undefined ? [] : (["llm_usage"] as const)),
    ...(setup.statsUrl === undefined ? [] : (["llm_stats"] as const)),
  ];
}

/** The two ops that ask the gateway a question and answer with what it said.
 *
 * They are handlers rather than resources: neither has a current value to hold
 * or a topic to push on, so each read is one question asked because a person
 * asked it. */
export function gatewayHandlers(setup: GatewaySetup, fetcher?: typeof fetch) {
  const call = fetcher === undefined ? {} : { fetch: fetcher };
  const usageUrl = setup.usageUrl;
  const statsUrl = setup.statsUrl;
  return {
    ...(usageUrl === undefined
      ? {}
      : {
          llm_usage_read: (input: HandlerInput): Promise<LlmUsageReadResult> =>
            readUsage({ url: usageUrl, ...call }, input.args as unknown as LlmUsageReadArgs),
        }),
    ...(statsUrl === undefined
      ? {}
      : {
          llm_stats_read: (input: HandlerInput): Promise<LlmStatsReadResult> =>
            readStats({ url: statsUrl, ...call }, input.args as unknown as LlmStatsReadArgs),
        }),
  };
}

export interface GatewayDeps {
  readonly self: InstanceId;
  readonly setup: GatewaySetup;
  readonly publish: (topic: string, data: unknown) => void;
  /** The gateway saw something happen for a session, which is an input of the
   * sessions domain (§5.1) rather than of either topic. */
  readonly onActivity?: () => void;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Replaces the outward read in tests. */
  readonly fetch?: typeof fetch;
  readonly settleMs?: number;
}

/** What this instance takes from the llm-gateway.
 *
 * One direction each. The gateway posts what it saw the moment it saw it,
 * because it runs as more than one process and a subscription would only ever
 * have reached whichever one it connected to; this instance asks for the
 * service report, because that is a document with a current value rather than
 * a stream of occurrences. Both arrive as events and neither is polled (M3):
 * the report is re-read when a posted event says an upstream refused, which is
 * this instance being told the one thing that changes it. */
export class Gateway {
  readonly requests: LlmRequests;
  readonly status: LlmStatus | undefined;
  readonly #source: WebhookSource | undefined;

  constructor(private readonly deps: GatewayDeps) {
    this.requests = new LlmRequests({
      self: deps.self,
      publish: deps.publish,
      ...(deps.onActivity === undefined ? {} : { onActivity: deps.onActivity }),
    });
    this.status =
      deps.setup.statusUrl === undefined
        ? undefined
        : new LlmStatus({
            self: deps.self,
            url: deps.setup.statusUrl,
            publish: deps.publish,
            ...(deps.log === undefined ? {} : { log: deps.log }),
            ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
            ...(deps.settleMs === undefined ? {} : { settleMs: deps.settleMs }),
          });
    this.#source =
      deps.setup.source === undefined
        ? undefined
        : {
            name: deps.setup.source.name,
            token: deps.setup.source.token,
            handle: (items) => this.take(items),
          };
  }

  /** The resource behind `llm_status`. A stand-in that states nothing when the
   * gateway's address is not configured — the topic's capability is absent
   * then, so nothing reaches it, and the attachment stays unconditional. */
  get statusResource(): UpstreamResource {
    return this.status ?? SILENT;
  }

  /** When the gateway last saw inference for a session (§5.1). */
  activeAt(sid: Sid, now?: Timestamp): Timestamp | undefined {
    return this.requests.activeAt(sid, now);
  }

  /** One HTTP request that reached this instance's entry, answered if it is
   * the webhook and left alone if it is not. */
  route(request: Request): Promise<Response | undefined> {
    return handleWebhook(request, this.#source, this.deps.log);
  }

  /** Stop what is pending. Called from the stop order (§8.5). */
  close(): void {
    this.status?.stop();
  }

  /** One posted batch. Every item is read on its own: a kind this instance
   * does not use is passed over, and one it cannot read at all is counted, so
   * a schema that moved shows up as a number instead of as silence. */
  private take(items: readonly unknown[]): void {
    let unreadable = 0;
    for (const value of items) {
      const item = parseGatewayItem(value);
      if (item === undefined) {
        unreadable += 1;
        continue;
      }
      if (item.kind === "request") {
        this.requests.record(item.info);
        this.status?.noteRequestStatus(item.info.status);
      } else if (item.kind === "response") {
        this.requests.note(item.info.sid, item.info.at);
      }
    }
    if (unreadable > 0) {
      this.deps.log?.("dropped items a gateway delivery could not be read as", { unreadable });
    }
  }
}

/** A resource with nothing behind it: subscribing to its topic starts nothing
 * and states nothing. */
const SILENT: UpstreamResource = {
  start(): void {},
  stop(): void {},
  snapshot(): readonly TopicValue[] {
    return [];
  },
};

function sourceName(file: string, name: string): string {
  if (!SOURCE_NAME.test(name)) {
    throw new ConfigError(
      file,
      "upstream.gateway_webhook_source must be lowercase letters, digits and dashes",
    );
  }
  return name;
}

/** One of the gateway's endpoints under the configured address. */
function endpoint(file: string, url: string, path: string): string {
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    throw new ConfigError(file, `upstream.gateway_url must be a URL, got ${url}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ConfigError(file, "upstream.gateway_url must be an http:// or https:// address");
  }
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}${path}`;
}

/** The secret the gateway presents.
 *
 * It is the gateway that writes the file and this instance that reads it, so
 * the default is the path the gateway defaults to (DR-0012) rather than one of
 * this instance's own — a path per config home would have to be configured on
 * both sides to mean the same thing. */
function token(file: string, config: UpstreamConfig, env: Env, source: string): string {
  const path = config.gateway_webhook_token_file ?? defaultTokenFile(env, source);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ConfigError(
      file,
      `upstream.gateway_webhook_source is set but its token file ${path} could not be read (${String(cause)})`,
    );
  }
  const token = raw.trim();
  if (token === "") throw new ConfigError(file, `the webhook token file ${path} is empty`);
  return token;
}

export function defaultTokenFile(env: Env, source: string): string {
  const xdg = env["XDG_DATA_HOME"];
  const home = env["HOME"];
  const base =
    xdg !== undefined && isAbsolute(xdg)
      ? xdg
      : join(home !== undefined && isAbsolute(home) ? home : homedir(), ".local", "share");
  return join(base, "ccmsg", `webhook-${source}.token`);
}
