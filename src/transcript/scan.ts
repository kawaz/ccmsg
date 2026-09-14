import type { TranscriptSubject } from "@ccmsg/protocol";
import { Classification, type Item } from "./items/index.ts";
import { positioned, span } from "./items/record.ts";

/** How many records one pass reads before it hands the loop back.
 *
 * A transcript is read whole by the ops that classify one, and reading it is
 * CPU rather than IO: the file arrives in one `await` and every record in it is
 * then parsed. Nothing else on the instance runs while that happens, so the
 * pass is cut into turns — small enough that the wait an op elsewhere sees is
 * one turn of parsing, large enough that the turns themselves cost nothing
 * measurable against the parsing they carry. */
const RECORDS_PER_TURN = 2000;

/** Hand the event loop back, so that whatever else is waiting on it runs.
 *
 * The pause of a macrotask rather than of a microtask: a promise resolved with
 * nothing to wait for is drained before the loop is reached at all, which would
 * make the yield a shape in the code and nothing in the behaviour. */
export function breathe(): Promise<void> {
  return new Promise((resume) => {
    setImmediate(resume);
  });
}

/** Whether this many records have gone by since the last pause. */
export function due(read: number): boolean {
  return read > 0 && read % RECORDS_PER_TURN === 0;
}

/** A whole transcript as the items it was read into, yielding as it goes.
 *
 * The same reading `classify` does over the whole text at once, cut into turns:
 * one `Classification` is fed chunk after chunk, so a call in one chunk is
 * still known when its result arrives in a later one, and the items come back
 * in the order the records are in. */
export async function classified(text: string, subject: TranscriptSubject): Promise<Item[]> {
  const reading = new Classification(subject);
  const lines = text.split("\n");
  const items: Item[] = [];
  let offset = 0;
  for (let from = 0; from < lines.length; from += RECORDS_PER_TURN) {
    const chunk = lines.slice(from, from + RECORDS_PER_TURN);
    for (const item of reading.readAll(positioned(chunk, offset))) items.push(item);
    for (const line of chunk) offset += span(line);
    if (from + RECORDS_PER_TURN < lines.length) await breathe();
  }
  return items;
}
