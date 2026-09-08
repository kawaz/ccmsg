import { type FSWatcher, existsSync, statSync, watch } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";

/** How much of a log is shown when one is opened.
 *
 * The reason to read a log is to find out what just happened, so what is wanted
 * is its recent end rather than its history — and a bound is what keeps
 * `daemon log --all` on a long-running host from being a whole day of lines
 * before the first new one arrives. */
export const LOG_TAIL_BYTES = 256 * 1024;

/** Where reading a log left off, so following it starts where showing it ended
 * and no line is shown twice. */
export interface Read {
  readonly lines: readonly string[];
  readonly end: number;
}

/** The bytes of `[from, to)`, cut back to the last complete line.
 *
 * A line still being written is left for the next read: the log's writer
 * appends whole lines (`Log`), so half a line on disk is one being written
 * right now rather than one that will stay half. */
async function readRange(file: string, from: number, to: number): Promise<Read> {
  if (to <= from) return { lines: [], end: from };
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    return {
      lines: complete.split("\n").filter((line) => line !== ""),
      end: from + Buffer.byteLength(complete),
    };
  } finally {
    await handle.close();
  }
}

/** The end of a log, and where it ends.
 *
 * The window starts at a byte rather than at a line, so the first line it lands
 * inside is dropped: a fragment of a record is not a record. */
export async function tailOf(file: string, bytes = LOG_TAIL_BYTES): Promise<Read> {
  if (!existsSync(file)) return { lines: [], end: 0 };
  const size = statSync(file).size;
  const from = Math.max(0, size - bytes);
  const read = await readRange(file, from, size);
  return from === 0 ? read : { lines: read.lines.slice(1), end: read.end };
}

/** Follow a file, on its own change notifications rather than on a clock.
 *
 * The watch is on the directory as well as on the file, because a log that does
 * not exist yet is one a watch cannot attach to and the instance writing it may
 * not have started.
 *
 * A file that shrank is one that was rotated or replaced, so reading continues
 * from its start: what was there before is gone, and holding the old offset
 * would skip everything written since. */
export function follow(
  file: string,
  from: number,
  onLines: (lines: readonly string[]) => void,
): { close(): void } {
  let offset = from;
  let reading: Promise<void> = Promise.resolve();
  const watchers: FSWatcher[] = [];
  const pull = (): void => {
    reading = reading.then(async () => {
      if (!existsSync(file)) return;
      const size = statSync(file).size;
      if (size < offset) offset = 0;
      const read = await readRange(file, offset, size);
      if (read.lines.length > 0) onLines(read.lines);
      offset = read.end;
    });
  };
  for (const at of new Set([file, dirname(file)])) {
    try {
      watchers.push(watch(at, pull));
    } catch {
      // Not there yet. The directory watch is what catches the file appearing;
      // when neither attaches there is nothing to follow and nothing to report.
    }
  }
  pull();
  return {
    close(): void {
      for (const watcher of watchers) watcher.close();
    },
  };
}

/** One log line as it is shown, which is the line itself when it is JSON and a
 * record carrying it when it is not.
 *
 * The instance writes JSON per line, so `--all` can add which instance a line
 * came from by putting the fields beside it. A line from anywhere else — a
 * crash the runtime printed, an init system's own words — is not JSON and is
 * shown as text under `line`, because dropping it would hide exactly the
 * failure somebody opened the log for. */
export function labelled(line: string, fields: Record<string, unknown>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return JSON.stringify({ ...fields, line });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return JSON.stringify({ ...fields, line });
  }
  return JSON.stringify({ ...fields, ...(parsed as Record<string, unknown>) });
}
