import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { TranscriptReadResult, Sid } from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";

/** How much of a transcript one read may carry.
 *
 * The contract lets a caller ask for less and says the instance narrows the
 * ask to its own limit, so this is both the ceiling and the default: a caller
 * that states nothing gets a slice of the size the paging was designed around,
 * and one that asks for a file's worth gets the same. It is the file-read
 * limit, for the same reason — one connection, one bounded payload. */
export const READ_LIMIT = 512 * 1024;

/** A slice of a transcript, read backwards from an offset.
 *
 * Paging is by byte offset aligned to line boundaries (§3.3): the end of the
 * file is read first, and each further page asks for what began before the
 * slice just read. Nothing is scanned whole and no index is built, which is
 * what lets a transcript of any size be read from its end.
 *
 * The offsets are the ones the `transcript` topic's frames carry, so what a
 * client reads and what arrives live stitch together without overlap. */
export function readSlice(
  sid: Sid,
  file: string,
  before?: number,
  maxBytes?: number,
): TranscriptReadResult {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new OpError("not_found", `the transcript of ${sid} could not be read`);
  }
  const until = before === undefined ? size : Math.min(before, size);
  const want = Math.min(maxBytes ?? READ_LIMIT, READ_LIMIT);
  const from = Math.max(0, until - want);
  // One byte before what was asked for, so the read can see whether it began
  // on a line boundary. Without it a slice starting exactly at a record's
  // first byte is indistinguishable from one starting inside the record
  // before it, and the whole first record would be dropped as a fragment.
  const probe = from === 0 ? 0 : from - 1;
  const text = slice(file, probe, until);
  // What of the read is whole records: everything up to the last newline. A
  // record the writer has not finished ends the file without one.
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { sid, lines: [], start: until, end: until, size };
  const complete = text.slice(0, lastNewline + 1);
  const end = probe + Buffer.byteLength(complete);
  const lines = complete.split("\n").slice(0, -1);
  let start = probe;
  if (probe < from) {
    // Whatever of a record preceded `from`: empty when `from` already sat on a
    // boundary, and the tail of a record the caller has already read
    // otherwise. Either way it is dropped, and its bytes — its own plus the
    // newline that ended it — are where the slice actually starts.
    const before = lines.shift() ?? "";
    start = probe + Buffer.byteLength(before) + 1;
  }
  return { sid, lines, start, end, size };
}

/** The bytes in a range, as text. A range that reads short — the file was
 * truncated between the stat and the read — yields what was actually there. */
function slice(file: string, from: number, to: number): string {
  if (to <= from) return "";
  const handle = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    const read = readSync(handle, buffer, 0, buffer.length, from);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(handle);
  }
}
