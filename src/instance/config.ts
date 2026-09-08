import { readFileSync } from "node:fs";
import type { InstanceId } from "@ccmsg/protocol";

/** Where the instance accepts WebSocket connections, and from whom.
 *
 * The two allowlists are the entry check of §3.1: what transport asks before a
 * request is upgraded. They are config-driven because who may reach an
 * instance is a deployment fact, not a property of the code. */
export interface EntryConfig {
  readonly host: string;
  /** 0 asks the kernel for a free port. */
  readonly port: number;
  /** Source addresses allowed to connect. Empty means every address the bind
   * itself already permits, which for the default loopback bind is this host. */
  readonly source_ips: readonly string[];
  /** `Origin` values a browser connection may present. Empty means any. */
  readonly origins: readonly string[];
}

/** The upstreams an instance writes down but does not read yet.
 *
 * Stated as a type so a config carrying them is accepted rather than rejected
 * as unknown, and so what is missing is missing in one visible place. Nothing
 * in the instance reads these fields. */
export interface UpstreamConfig {
  readonly gateway_url?: string;
  readonly gateway_webhook_source?: string;
  readonly terminal_gateway?: string;
  readonly launcher_template?: string;
  readonly sandbox_origin?: string;
}

export interface InstanceConfig {
  /** Mesh endpoints to dial (§7.2). The same list goes to every instance, so
   * it never names the instance reading it (§7.1). */
  readonly peers: readonly InstanceId[];
  /** Absent when this instance serves the unix socket only. */
  readonly entry?: EntryConfig;
  readonly upstream: UpstreamConfig;
  /** Whether delivery tries the harness's messaging socket before the `inbox`
   * topic (§4.1 condition 0). On, because the protocol has been read off a
   * running harness; off is for a harness generation that turns out to speak
   * something else, and costs only the reach route (b) never had. */
  readonly direct_delivery: boolean;
}

/** A config file that could not be understood.
 *
 * Its own class so startup can tell "the operator wrote something wrong" from
 * any other failure, and refuse to run rather than continuing with the feature
 * that setting was for silently off (§8.3, DV-Q9). */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    msg: string,
  ) {
    super(`${file}: ${msg}`);
    this.name = "ConfigError";
  }
}

/** An instance with no config file: the unix socket, no peers, no upstreams.
 *
 * Absent is not broken. A config that is not there states nothing wrong, while
 * one that is there and unreadable states something wrong — only the second is
 * the fail-fast case. */
export const DEFAULT_CONFIG: InstanceConfig = { peers: [], upstream: {}, direct_delivery: true };

/** Read the config, once, at startup (DV-Q8).
 *
 * There is no watch and no reload: the file is small, an instance is cheap to
 * restart because almost nothing it holds is persistent (§3.6), and restarting
 * is therefore the whole of "apply a config change" (§8.2). */
export function loadConfig(file: string): InstanceConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(file, `not valid JSON (${String(cause)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(file, "the top level must be a JSON object");
  }
  const fields = parsed as Record<string, unknown>;
  return {
    peers: peersOf(file, fields["peers"]),
    ...(fields["entry"] === undefined ? {} : { entry: entryOf(file, fields["entry"]) }),
    upstream: upstreamOf(file, fields["upstream"]),
    direct_delivery: flagOf(
      file,
      "direct_delivery",
      fields["direct_delivery"],
      DEFAULT_CONFIG.direct_delivery,
    ),
  };
}

function flagOf(file: string, at: string, raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") throw new ConfigError(file, `${at} must be true or false`);
  return raw;
}

const INSTANCE_ID = /^wss?:\/\/[^\s?#]+$/;

function peersOf(file: string, raw: unknown): readonly InstanceId[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError(file, "peers must be an array of endpoint URLs");
  return raw.map((peer) => {
    if (typeof peer !== "string" || !INSTANCE_ID.test(peer)) {
      throw new ConfigError(file, `peers must be ws:// or wss:// URLs, got ${String(peer)}`);
    }
    return peer;
  });
}

function entryOf(file: string, raw: unknown): EntryConfig {
  const fields = objectOf(file, "entry", raw);
  const port = fields["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(file, "entry.port must be a port number, or 0 to be assigned one");
  }
  const host = fields["host"] ?? "127.0.0.1";
  if (typeof host !== "string" || host === "") {
    throw new ConfigError(file, "entry.host must be an address to bind");
  }
  return {
    host,
    port,
    source_ips: stringsOf(file, "entry.source_ips", fields["source_ips"]),
    origins: stringsOf(file, "entry.origins", fields["origins"]),
  };
}

function upstreamOf(file: string, raw: unknown): UpstreamConfig {
  if (raw === undefined) return {};
  const fields = objectOf(file, "upstream", raw);
  const config: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== "string") {
      throw new ConfigError(file, `upstream.${name} must be a string`);
    }
    config[name] = value;
  }
  return config as UpstreamConfig;
}

function objectOf(file: string, at: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(file, `${at} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function stringsOf(file: string, at: string, raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new ConfigError(file, `${at} must be an array of strings`);
  }
  return raw as string[];
}
