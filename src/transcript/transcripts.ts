import type { InstanceId, Sid } from "@ccmsg/protocol";
import { topicParam, type TopicValue, type UpstreamResource } from "../topics/index.ts";
import { NO_FACTS, type TranscriptFacts, TranscriptFold } from "./fold.ts";
import { Classification, type Item, positioned } from "./items/index.ts";
import { type Appended, TranscriptTail } from "./tail.ts";

/** How many items a subscription to `transcript.items:<sid>` opens with.
 *
 * The tail of the same megabyte the fold is seeded from, bounded by a count
 * because that read is bounded by bytes: a file of many small records would
 * otherwise make the opening frame as large as the read that produced it. Two
 * hundred items is several turns at the sizes the harness writes, which is
 * more than a live view shows at once — and a client that wants further back
 * asks for it by range rather than waiting for a snapshot to grow. */
export const ITEMS_SNAPSHOT = 200;

/** Which of the two topics a name is. Both are fed by one tail, so the
 * resource is entered by either name and answers each in its own vocabulary. */
function isItems(topic: string): boolean {
  return topic.startsWith("transcript.items:");
}

export interface TranscriptsDeps {
  readonly self: InstanceId;
  /** Where a session's transcript is: what it announced when it greeted
   * (§5.1), or the `<sid>.jsonl` under this instance's `projects/` that
   * carries its name. A sid neither names nor is named by a file there has
   * none, and nothing is guessed for it. */
  readonly pathOf: (sid: Sid) => string | undefined;
  /** The one way a value reaches subscribers (§6.1). */
  readonly publish: (topic: string, data: unknown) => void;
  /** The fold now says something different about this session. What the fold
   * settles is an input to the sessions domain (§5.1), so the domain that
   * states those values is told to state them again. */
  readonly onFacts: (sid: Sid) => void;
  /** Overrides the confirmation poll, for a test that cannot wait. */
  readonly pollMs?: number;
}

/** One tail and one fold per session, and the `transcript:<sid>` topic they
 * feed (§3.3).
 *
 * The fold is one per session, not one per consumer: a line is read once and
 * every value it settles is settled from that read, so the api error, the last
 * human input and the appended bytes are three uses of one pass rather than
 * three passes (M5).
 *
 * A tail runs while something wants it and stops when nothing does (§6.3).
 * Subscription is one such want; a `hold` is the other, for the values the
 * sessions domain states about a session nobody is watching the transcript of.
 * They are counted together, so the last one to go is what stops the tail. */
export class Transcripts implements UpstreamResource {
  readonly #followed = new Map<Sid, Followed>();

  constructor(private readonly deps: TranscriptsDeps) {}

  // --- UpstreamResource (§6.3)

  start(topic: string): void {
    const sid = topicParam(topic);
    if (sid !== undefined) this.hold(sid);
  }

  stop(topic: string): void {
    const sid = topicParam(topic);
    if (sid !== undefined) this.release(sid);
  }

  /** Where the transcript ends as the subscription begins. What follows starts
   * there, which is the whole of the snapshot for a topic whose frames are an
   * append rather than a value (§6.2). A session whose transcript this
   * instance cannot find has nothing to state, and the subscriber begins at
   * the first thing appended after one appears. */
  snapshot(topic: string): readonly TopicValue[] {
    const sid = topicParam(topic);
    const followed = sid === undefined ? undefined : this.#followed.get(sid);
    if (sid === undefined || followed === undefined) return [];
    // The items topic holds a list that is only appended to, so its snapshot
    // is the end of that list rather than a place to start from.
    const data = isItems(topic)
      ? { sid, items: [...followed.recent] }
      : { sid, size: followed.tail.size };
    return [{ instance: this.deps.self, data }];
  }

  /** What the fold currently says about a session. Empty for one not being
   * followed, which is the same as a transcript that has said nothing. */
  facts(sid: Sid): TranscriptFacts {
    return this.#followed.get(sid)?.fold.facts ?? NO_FACTS;
  }

  /** Whether a session's transcript is being followed, which is how "the
   * subscription drives the resource" is observable from outside. */
  following(sid: Sid): boolean {
    return this.#followed.get(sid)?.tail.running === true;
  }

  /** Ask for a session's transcript to be followed. Each hold is released
   * once; the tail runs until the last is. */
  hold(sid: Sid): void {
    const held = this.#followed.get(sid);
    if (held !== undefined) {
      held.holds += 1;
      return;
    }
    const path = this.deps.pathOf(sid);
    if (path === undefined) return;
    const followed = this.#follow(sid, path);
    this.#followed.set(sid, followed);
    void followed.tail.start();
  }

  release(sid: Sid): void {
    const held = this.#followed.get(sid);
    if (held === undefined) return;
    held.holds -= 1;
    if (held.holds > 0) return;
    this.#followed.delete(sid);
    held.tail.stop();
    // What the fold held goes with it: the values it derived describe a file
    // this instance is no longer reading, and stating them from memory would
    // outlive the reading that justified them.
    this.deps.onFacts(sid);
  }

  /** Stop following everything. What shutdown reaches through the topics it
   * drops; a hold taken outside a subscription needs the same door. */
  stopAll(): void {
    const followed = new Map(this.#followed);
    this.#followed.clear();
    for (const [sid, entry] of followed) {
      entry.tail.stop();
      this.deps.onFacts(sid);
    }
  }

  #follow(sid: Sid, path: string): Followed {
    const fold = new TranscriptFold();
    const followed: Followed = {
      holds: 1,
      fold,
      reading: new Classification(),
      recent: [],
      tail: new TranscriptTail(path, {
        onSeed: (seeded) => {
          // The end of the file as it already stood: it settles what the fold
          // says and opens the reading that classifies what comes next, and it
          // is not an append, so nothing is published for it.
          this.#keep(sid, seeded);
          if (foldAll(fold, seeded.lines)) this.deps.onFacts(sid);
        },
        onAppended: (appended) => this.#appended(sid, fold, appended),
        onTruncated: () => {
          fold.reset();
          this.#reset(sid);
          this.deps.onFacts(sid);
        },
        ...(this.deps.pollMs === undefined ? {} : { pollMs: this.deps.pollMs }),
      }),
    };
    return followed;
  }

  /** The one pass over what was appended: the lines go to the fold, to the
   * classification and to the two topics, and are not read again for any of
   * them (M5).
   *
   * Both topics are fed whether or not either is subscribed to, because the
   * classification is a reading of the whole file kept open: a call answered
   * now was made in bytes that went past long ago, and a reading started when
   * somebody subscribed would not know it. What the memory holds is bounded —
   * the calls still outstanding, and the items of the opening frame. */
  #appended(sid: Sid, fold: TranscriptFold, appended: Appended): void {
    const changed = foldAll(fold, appended.lines);
    this.deps.publish(`transcript:${sid}`, {
      sid,
      lines: [...appended.lines],
      start: appended.start,
      end: appended.end,
      size: appended.size,
    });
    const items = this.#keep(sid, appended);
    // A record still being written was not read, so there is nothing to say
    // about it yet; a chunk whose records were all the interface's own
    // bookkeeping says nothing either.
    if (items.length > 0) this.deps.publish(`transcript.items:${sid}`, { sid, items });
    if (changed) this.deps.onFacts(sid);
  }

  /** What a chunk was read as, with the end of it held for the next
   * subscription to open on. A result that fills in a call already handed over
   * is not sent again: the call named nothing to wait for and the result names
   * the call, so a reader ties the two together from what it already has. */
  #keep(sid: Sid, chunk: Appended): readonly Item[] {
    const followed = this.#followed.get(sid);
    if (followed === undefined) return [];
    const items = followed.reading.readAll(positioned(chunk.lines, chunk.start));
    followed.recent.push(...items);
    if (followed.recent.length > ITEMS_SNAPSHOT) {
      followed.recent.splice(0, followed.recent.length - ITEMS_SNAPSHOT);
    }
    return items;
  }

  /** The file is not the one that was being read, so neither the reading nor
   * what it produced describes it. */
  #reset(sid: Sid): void {
    const followed = this.#followed.get(sid);
    if (followed === undefined) return;
    followed.reading = new Classification();
    followed.recent.length = 0;
  }
}

interface Followed {
  holds: number;
  readonly fold: TranscriptFold;
  /** The transcript read as items, kept open while the tail runs. */
  reading: Classification;
  /** The end of what has been read, which is what a subscription opens on. */
  readonly recent: Item[];
  readonly tail: TranscriptTail;
}

function foldAll(fold: TranscriptFold, lines: readonly string[]): boolean {
  let changed = false;
  for (const line of lines) {
    if (fold.line(line)) changed = true;
  }
  return changed;
}
