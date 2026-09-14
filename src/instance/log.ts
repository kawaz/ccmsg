import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The instance's log: one writer, and the file in the order the calls were
 * made (DESIGN §2.5).
 *
 * A line is written where anything at all is happening — a lifecycle step, a
 * mesh callback, a session appearing — so the write cannot be the one thing
 * that stops the instance while it lands (DR-0015). Each append is chained onto
 * the one before it, which is what keeps the order the calls stated; what a
 * kill can cost is the last line or two that had not reached the file yet, and
 * for a log that is a cheaper loss than holding the process still for every
 * line.
 *
 * `flush` is for the one moment that loss is avoidable: a stop that is being
 * waited on can wait for its own last line. */
export class Log {
  /** The appends already asked for, as one chain. */
  #written: Promise<void> = Promise.resolve();

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
    this.#written = this.#written.then(async () => {
      try {
        await appendFile(this.file, `${line}\n`);
      } catch {
        // A log that cannot be written is not a reason to stop serving.
      }
    });
  }

  /** Settle once every line asked for so far is on disk. */
  async flush(): Promise<void> {
    await this.#written;
  }
}
