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
 * Sharing a first record id means two files begin with the same record, which
 * happens only by duplication. Which of the pair is the copy is then read out
 * of the records themselves, by walking each file's ids against the other's as
 * a set rather than position by position: the ancestor holds records the fork
 * did not copy — a subagent's turns interleave into the parent and not into
 * what was copied — so the fork's run into the ancestor reaches past where the
 * ancestor's run into the fork stops. The longer run is the copy.
 *
 * Only when the two runs are equal does the copying leave no trace of its
 * direction, and only then is creation order asked for. A filesystem that
 * states no creation time answers nothing there rather than falling back to a
 * time that means something else: a transcript is appended to for as long as
 * its session runs, so every other timestamp a file carries orders the two by
 * when they were last written, which is unrelated to which was copied from
 * which — and on a live ancestor points the wrong way.
 *
 * Absent covers a session that is no fork, one whose ancestor file is gone,
 * and that undecidable pair. Nothing left on disk tells them apart, and none
 * of them has a seam to place. */
export function forkOrigin(sid: Sid, files: TranscriptFiles): ForkOrigin | undefined {
  const file = files.session(sid);
  const ours = recordIds(file);
  const head = ours?.[0];
  if (ours === undefined || head === undefined) return undefined;
  const mine = new Set(ours);

  const dir = dirname(file);
  let best: { sid: Sid; copied: number } | undefined;
  for (const candidate of files.all()) {
    if (candidate.file === file || dirname(candidate.file) !== dir) continue;
    const theirs = recordIds(candidate.file);
    if (theirs === undefined || theirs[0] !== head) continue;
    const copied = run(ours, new Set(theirs));
    const back = run(theirs, mine);
    // A run that reaches no further than theirs makes us their ancestor rather
    // than their copy; an equal one says the records cannot tell, and creation
    // order is what is left.
    if (copied === 0 || back > copied) continue;
    if (back === copied && !older(candidate.file, file)) continue;
    // Sibling forks of one ancestor share a prefix too, so several files can
    // match; the longest run is the nearest ancestor and the true seam.
    if (best === undefined || copied > best.copied) best = { sid: candidate.sid, copied };
  }
  if (best === undefined) return undefined;
  // The whole file being copied means no forked turns exist yet, and there is
  // no seam to draw below the last record.
  if (best.copied >= ours.length) return undefined;
  const boundary = ours[best.copied - 1];
  if (boundary === undefined) return undefined;
  return { sid: best.sid, boundary_uuid: boundary, copied: best.copied };
}

/** How far into a file's records every id is one the other file also holds. */
function run(ids: readonly string[], other: ReadonlySet<string>): number {
  let reached = 0;
  while (reached < ids.length && other.has(ids[reached] ?? "")) reached += 1;
  return reached;
}

/** Whether one file was created before the other, when the filesystem says.
 *
 * A creation time of zero is a filesystem that does not record one, which is
 * not an ancient file: two of those are simply not ordered, and the pair they
 * belong to gets no answer. */
function older(candidate: string, file: string): boolean {
  const theirs = bornAt(candidate);
  const ours = bornAt(file);
  if (theirs === undefined || ours === undefined) return false;
  return theirs < ours;
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

/** When a file came into being, for the one pair the records cannot order.
 *
 * Only the creation time, and only when the filesystem states one: everything
 * else a file carries says when it was last written, which for a transcript is
 * how long its session ran rather than when it began. Not rounded to the
 * millisecond the contract states instants in either — two transcripts written
 * moments apart share one, and the whole use of this value is telling which
 * came first. */
function bornAt(file: string): number | undefined {
  try {
    const born = statSync(file).birthtimeMs;
    return born > 0 ? born : undefined;
  } catch {
    return undefined;
  }
}
