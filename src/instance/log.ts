import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The instance's log: one writer, and every line on disk before the call
 * returns (§3.6).
 *
 * The reason to read a log is to find out why a process stopped, so the line
 * that matters most is the last one written before it did. A buffered writer
 * is the one that loses exactly that line, so this one appends synchronously
 * and holds nothing — the cost is a write per line, on a file that takes a
 * line per lifecycle event rather than per request. */
export class Log {
  constructor(
    private readonly file: string,
    /** Mirrored to stderr so a foreground run shows what it is doing. */
    private readonly echo: boolean = true,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  write(message: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ at: new Date().toISOString(), message, ...fields });
    if (this.echo) process.stderr.write(`${line}\n`);
    try {
      appendFileSync(this.file, `${line}\n`);
    } catch {
      // A log that cannot be written is not a reason to stop serving.
    }
  }
}
