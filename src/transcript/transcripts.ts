import type { InstanceId, Sid } from "@ccmsg/protocol";
import { topicParam, type TopicValue, type UpstreamResource } from "../topics/index.ts";
import { type TranscriptFacts, TranscriptFold } from "./fold.ts";
import { type Appended, TranscriptTail } from "./tail.ts";

export interface TranscriptsDeps {
  readonly self: InstanceId;
  /** Where a session's transcript is, as the session announced it (§5.1). A
   * sid with no path is one that never said, and nothing is guessed for it. */
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
    return [{ instance: this.deps.self, data: { sid, size: followed.tail.size } }];
  }

  /** What the fold currently says about a session. Empty for one not being
   * followed, which is the same as a transcript that has said nothing. */
  facts(sid: Sid): TranscriptFacts {
    return this.#followed.get(sid)?.fold.facts ?? {};
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
      tail: new TranscriptTail(path, {
        onSeed: (lines) => {
          // The end of the file as it already stood: it settles what the fold
          // says, and it is not an append, so nothing is published for it.
          if (foldAll(fold, lines)) this.deps.onFacts(sid);
        },
        onAppended: (appended) => this.#appended(sid, fold, appended),
        onTruncated: () => {
          fold.reset();
          this.deps.onFacts(sid);
        },
        ...(this.deps.pollMs === undefined ? {} : { pollMs: this.deps.pollMs }),
      }),
    };
    return followed;
  }

  /** The one pass over what was appended: the lines go to the fold and to the
   * topic, in that order, and are not read a second time for either (M5). */
  #appended(sid: Sid, fold: TranscriptFold, appended: Appended): void {
    const changed = foldAll(fold, appended.lines);
    this.deps.publish(`transcript:${sid}`, {
      sid,
      lines: [...appended.lines],
      start: appended.start,
      end: appended.end,
      size: appended.size,
    });
    if (changed) this.deps.onFacts(sid);
  }
}

interface Followed {
  holds: number;
  readonly fold: TranscriptFold;
  readonly tail: TranscriptTail;
}

function foldAll(fold: TranscriptFold, lines: readonly string[]): boolean {
  let changed = false;
  for (const line of lines) {
    if (fold.line(line)) changed = true;
  }
  return changed;
}
