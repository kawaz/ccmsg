import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import type { Capability } from "@ccmsg/protocol";
import { ConfigError, type UpstreamConfig } from "../instance/config.ts";

/** One exchange with the helper: a line in, a line out.
 *
 * The helper is a process that reads one JSON line and answers with one, and
 * this is that process as everything above it needs to see it. Named rather
 * than reached through directly so the wire can be exercised without a program
 * on the host answering it. */
export interface HelperChannel {
  write(line: string): Promise<void>;
  /** The next line the helper wrote, or `undefined` once it has written its
   * last — which is how a helper that died is told from one that is thinking. */
  read(): Promise<string | undefined>;
  kill(): void;
}

/** Read the helper the config names (§8.2).
 *
 * A helper that is named and cannot be run ends the start rather than leaving
 * translation silently off (DV-Q9): an instance without the capability looks
 * exactly like one nobody configured, and the operator who named a program
 * meant to have it. */
export function translateSetup(config: UpstreamConfig, file: string): string | undefined {
  const helper = config.translate_helper;
  if (helper === undefined) return undefined;
  if (!isAbsolute(helper)) {
    throw new ConfigError(file, "upstream.translate_helper must be an absolute path");
  }
  try {
    accessSync(helper, constants.X_OK);
  } catch (cause) {
    throw new ConfigError(
      file,
      `upstream.translate_helper ${helper} cannot be run (${String(cause)})`,
    );
  }
  return helper;
}

/** Present exactly where a helper is configured: translation happens on this
 * host or not at all, and a client is told which before it asks. */
export function translateCapabilities(helper?: string): Capability[] {
  return helper === undefined ? [] : ["translate"];
}

/** Start the configured helper, speaking one JSON line at a time. */
export function spawnHelper(path: string): HelperChannel {
  const child = Bun.spawn([path], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const stdin = child.stdin;
  const lines = readLines(child.stdout);
  return {
    write: async (line) => {
      // The write is awaited because a full pipe answers with a promise rather
      // than a count, and a line half-taken is a batch the helper never sees.
      await stdin.write(line);
      await stdin.flush();
    },
    read: () => lines(),
    kill: () => {
      child.kill();
    },
  };
}

/** The helper's output, one line at a time. */
function readLines(stream: ReadableStream<Uint8Array>): () => Promise<string | undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.trim() !== "") return line;
        continue;
      }
      const { done, value } = await reader.read();
      if (done) return undefined;
      buffer += decoder.decode(value, { stream: true });
    }
  };
}
