import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { ForkOrigin, Sid } from "@ccmsg/protocol";
import { readRecord, type TranscriptFiles } from "../transcript/index.ts";

/** How large a transcript may be and still be swept.
 *
 * Finding a seam means reading two files whole, and the answer decorates a
 * divider. A transcript past this size simply yields no seam, which is the same
 * answer the op already gives for a session that is no fork. */
const SWEEP_MAX_BYTES = 64 * 1024 * 1024;

/** Where a forked session stopped being a copy of its ancestor.
 *
 * Forking duplicates the ancestor's records keeping each record id, and
 * rewrites the session id on every copy — so nothing inside the file marks a
 * copied record, and the seam can only be found by comparing against the
 * sibling transcripts beside it.
 *
 * Two stages. Sharing a first record id means two files begin with the same
 * record, which happens only by duplication; requiring the candidate to be the
 * older of the pair settles which is the ancestor. Then the fork's records are
 * walked against the ancestor's as a set rather than position by position: the
 * ancestor also holds records the fork did not copy — a subagent's turns
 * interleave into the parent and not into what was copied — so the copied run
 * is a subsequence of the ancestor rather than a prefix of it.
 *
 * Absent covers both a session that is no fork and one whose ancestor file is
 * gone. Nothing left on disk tells those apart, and neither has a seam to
 * place. */
export function forkOrigin(sid: Sid, files: TranscriptFiles): ForkOrigin | undefined {
  const file = files.session(sid);
  const ours = recordIds(file);
  const head = ours?.[0];
  if (ours === undefined || head === undefined) return undefined;
  const born = bornAt(file);
  if (born === undefined) return undefined;

  const dir = dirname(file);
  let best: { sid: Sid; copied: number } | undefined;
  for (const candidate of files.all()) {
    if (candidate.file === file || dirname(candidate.file) !== dir) continue;
    const theirBirth = bornAt(candidate.file);
    if (theirBirth === undefined || theirBirth >= born) continue;
    const theirs = recordIds(candidate.file);
    if (theirs === undefined || theirs[0] !== head) continue;
    const ancestor = new Set(theirs);
    let copied = 0;
    while (copied < ours.length && ancestor.has(ours[copied] ?? "")) copied += 1;
    // Sibling forks of one ancestor share a prefix too, so several files can
    // match; the longest run is the nearest ancestor and the true seam.
    if (copied > 0 && (best === undefined || copied > best.copied)) {
      best = { sid: candidate.sid, copied };
    }
  }
  if (best === undefined) return undefined;
  // The whole file being copied means no forked turns exist yet, and there is
  // no seam to draw below the last record.
  if (best.copied >= ours.length) return undefined;
  const boundary = ours[best.copied - 1];
  if (boundary === undefined) return undefined;
  return { sid: best.sid, boundary_uuid: boundary, copied: best.copied };
}

/** Every record id in a file, in order. Undefined for a file too large to
 * sweep or one that could not be read. */
function recordIds(file: string): string[] | undefined {
  let text: string;
  try {
    if (statSync(file).size > SWEEP_MAX_BYTES) return undefined;
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    // Most of a transcript's bytes sit in a handful of very large records, and
    // parsing one to learn it carries no id is the cost this avoids.
    if (line === "" || !line.includes('"uuid"')) continue;
    const uuid = readRecord(line)?.uuid;
    if (uuid !== undefined) ids.push(uuid);
  }
  return ids;
}

/** When a file came into being, which is the only thing that says which of two
 * files holding the same records is the ancestor.
 *
 * Not rounded to the millisecond the contract states instants in: two
 * transcripts written moments apart can share a millisecond, and the whole use
 * of this value is telling which of the two came first. */
function bornAt(file: string): number | undefined {
  try {
    const stat = statSync(file);
    return stat.birthtimeMs || stat.ctimeMs;
  } catch {
    return undefined;
  }
}
