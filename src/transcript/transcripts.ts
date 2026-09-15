import type { InstanceId, SessionStatusStanding, Sid } from "@ccmsg/protocol";
import { CONFIRM_POLL_MS } from "../sessions/harness.ts";
import { topicParam, type TopicValue, type UpstreamResource } from "../topics/index.ts";
import type { FoldCache } from "./cache.ts";
import { NO_FACTS, type TranscriptFacts, TranscriptFold } from "./fold.ts";
import { Classification, type Item, positioned } from "./items/index.ts";
import { type Appended, TranscriptTail } from "./tail.ts";

/** How many items a subscription to `transcript.items:<sid>` opens with.
 *
 * The end of a reading that covers the whole file, bounded by a count because
 * the whole file is what was read: an opening frame is what a live view draws,
 * and two hundred items is several turns at the sizes the harness writes —
 * more than such a view shows at once. A client that wants further back asks
 * for it by range rather than waiting for a snapshot to grow. */
export const ITEMS_SNAPSHOT = 200;

/** Which of the two topics a name is. Both are fed by one tail, so the
 * resource is entered by either name and answers each in its own vocabulary. */
function isItems(topic: string): boolean {
  return topic.startsWith("transcript.items:");
}

export interface TranscriptsDeps {
  readonly self: InstanceId;
  /** Where a session's transcript is: what it announced when it greeted
   * (DESIGN §4.2), or the `<sid>.jsonl` under this instance's `projects/` that
   * carries its name. A sid neither names nor is named by a file there has
   * none, and nothing is guessed for it. */
  readonly pathOf: (sid: Sid) => Promise<string | undefined>;
  /** Where a reading of a transcript is kept so the next one resumes from it.
   * Absent leaves every reading starting from the file's beginning, which is
   * the same answer at the price of reading it again. */
  readonly cache?: FoldCache;
  /** The one way a value reaches subscribers (DESIGN §6.1). */
  readonly publish: (topic: string, data: unknown) => void;
  /** The fold now says something different about this session. What the fold
   * settles is an input to the sessions domain (DESIGN §4.2), so the domain that
   * states those values is told to state them again. */
  readonly onFacts: (sid: Sid) => void;
  /** Overrides the confirmation poll, for a test that cannot wait. */
  readonly pollMs?: number;
}

/** One tail and one fold per session, and the `transcript:<sid>` topic they
 * feed (DESIGN §2.3).
 *
 * The fold is one per session, not one per consumer: a line is read once and
 * every value it settles is settled from that read, so the api error, the last
 * human input and the appended bytes are three uses of one pass rather than
 * three passes (M5).
 *
 * A tail runs while something wants it and stops when nothing does (DESIGN §6.3).
 * Subscription is one such want; a `hold` is the other, for the values the
 * sessions domain states about a session nobody is watching the transcript of.
 * They are counted together, so the last one to go is what stops the tail. */
export class Transcripts implements UpstreamResource {
  readonly #followed = new Map<Sid, Followed>();

  constructor(private readonly deps: TranscriptsDeps) {}

  // --- UpstreamResource (DESIGN §6.3)

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
   * append rather than a value (DESIGN §6.2). A session whose transcript this
   * instance cannot find has nothing to state, and the subscriber begins at
   * the first thing appended after one appears.
   *
   * Answered once the transcript has been read, which is what makes the size
   * and the items it states describe the same whole file the fold does. */
  async snapshot(topic: string): Promise<readonly TopicValue[]> {
    const sid = topicParam(topic);
    if (sid === undefined) return [];
    await this.ready(sid);
    const followed = this.#followed.get(sid);
    const tail = followed?.tail;
    if (followed === undefined || tail === undefined) return [];
    // The items topic holds a list that is only appended to, so its snapshot
    // is the end of that list rather than a place to start from.
    const data = isItems(topic) ? { sid, items: [...followed.recent] } : { sid, size: tail.size };
    return [{ instance: this.deps.self, data }];
  }

  /** What the fold currently says about a session. Empty for one not being
   * followed, which is the same as a transcript that has said nothing. */
  facts(sid: Sid): TranscriptFacts {
    return this.#followed.get(sid)?.fold.facts ?? NO_FACTS;
  }

  /** What the fold of a session is worth, as `peers.session_status` states it
   * (contract, `SessionStatusStanding`) — everything but `frozen`, which is a
   * count of processes rather than anything about the reading and belongs to
   * whoever holds the runs.
   *
   * A session nothing is following stands at `absent` for the same reason one
   * whose file is not there does: there is no fold here to read, and the two
   * are one answer to the client's question of whether the status is worth
   * reading. Following starts when something wants the fold, which is the
   * subscription driving the resource (DESIGN §6.3). */
  standing(sid: Sid): SessionStatusStanding {
    return this.#followed.get(sid)?.standing ?? "absent";
  }

  /** Two or more processes are writing this session's transcript, or are no
   * longer.
   *
   * While they are, nothing of the file is read: the records interleave, the
   * offsets are wrong, and the fold would state a reading that describes
   * neither run. So the tail stops and the last value the fold could be
   * trusted for is left standing (DR-0001 §3).
   *
   * When they stop, the reading begins again from the top rather than from
   * where it was: the cached offset was taken from a file two writers have
   * since moved, so it names a position in nothing. */
  duplicated(sid: Sid, now: boolean): void {
    const followed = this.#followed.get(sid);
    if (followed === undefined || followed.frozen === now) return;
    followed.frozen = now;
    if (now) {
      this.#let(followed);
      followed.standing = "frozen";
      return;
    }
    const path = followed.path;
    if (path !== undefined) void this.deps.cache?.drop(path);
    followed.fold.reset();
    this.#reset(followed);
    followed.tail = undefined;
    followed.path = undefined;
    followed.standing = "absent";
    followed.ready = this.#open(sid, followed);
  }

  /** When the transcript held for a session has been read. Whoever states a
   * value the fold settles waits on this, so what is stated describes the
   * whole file rather than the part of it read so far (CT-Q8). */
  ready(sid: Sid): Promise<void> {
    return this.#followed.get(sid)?.ready ?? Promise.resolve();
  }

  /** Whether a session's transcript is being followed, which is how "the
   * subscription drives the resource" is observable from outside. */
  following(sid: Sid): boolean {
    return this.#followed.get(sid)?.tail?.running === true;
  }

  /** Ask for a session's transcript to be followed. Each hold is released
   * once; the tail runs until the last is. */
  hold(sid: Sid): void {
    const held = this.#followed.get(sid);
    if (held !== undefined) {
      held.holds += 1;
      return;
    }
    const followed: Followed = {
      holds: 1,
      fold: new TranscriptFold(),
      reading: new Classification(),
      recent: [],
      ready: Promise.resolve(),
      standing: "absent",
      frozen: false,
    };
    this.#followed.set(sid, followed);
    followed.ready = this.#open(sid, followed);
  }

  release(sid: Sid): void {
    const held = this.#followed.get(sid);
    if (held === undefined) return;
    held.holds -= 1;
    if (held.holds > 0) return;
    this.#followed.delete(sid);
    this.#let(held);
    void this.#remember(held);
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
      this.#let(entry);
      void this.#remember(entry);
      this.deps.onFacts(sid);
    }
  }

  /** Find the file and read it, or — for a session whose file is not there to
   * be found — finish with nothing and look again.
   *
   * The entry stays either way, because the holds on it do: a hold is a
   * promise to release, and an entry taken out from under its holders would
   * have their releases land on whatever entry the next hold made under the
   * same sid, stopping a tail somebody else is still reading. What `ready`
   * waits on is the reading as it stands, so a session with no file yet answers
   * as one that has said nothing, and the subscriber begins at the first thing
   * appended after one appears.
   *
   * Every await here is a window in which the last hold may be released, so
   * what was true before each one is asked again after it (DR-0015 §2.5): a
   * reading nobody wants any more stops where it is, rather than going on to
   * put a watch on a file and states about it into a session that has since
   * been opened afresh. */
  async #open(sid: Sid, followed: Followed, appeared = false): Promise<void> {
    if (followed.frozen) return;
    const path = await this.#find(sid);
    if (!this.#holds(sid, followed) || followed.frozen) return;
    if (path === undefined) {
      followed.standing = "absent";
      this.#lookAgain(sid, followed, true);
      return;
    }
    followed.path = path;
    followed.standing = "folding";
    try {
      const kept = await this.deps.cache?.read(path);
      if (!this.#holds(sid, followed) || followed.frozen) return;
      if (kept !== undefined) {
        followed.fold.restore(kept.fold);
        followed.recent.push(...kept.items);
        // The reading resumes as the same reading: the turn it had reached and
        // the calls it was still waiting on are taken up with the items they
        // belong to, so a result answered now names the call a reader holds.
        followed.reading.restore(kept.reading, followed.recent);
      }
      const tail = new TranscriptTail(path, {
        onExisting: (read) => {
          // What was already in the file. To a reading that found no file the
          // first time it looked, this is what was appended since — the
          // subscriber opened on nothing, and these are the frames after it.
          // To any other it settles what the fold says and opens the reading
          // that classifies what comes next, and it is not an append, so
          // nothing is published for it.
          if (appeared) {
            this.#appended(sid, followed, read);
            return;
          }
          this.#keep(followed, read);
          foldAll(followed.fold, read.lines);
        },
        onAppended: (appended) => this.#appended(sid, followed, appended),
        onTruncated: () => {
          followed.fold.reset();
          this.#reset(followed);
          void this.deps.cache?.drop(path);
          this.deps.onFacts(sid);
        },
        ...(this.deps.pollMs === undefined ? {} : { pollMs: this.deps.pollMs }),
      });
      followed.tail = tail;
      await tail.start(kept?.offset ?? 0);
      if (followed.frozen) {
        tail.stop();
        return;
      }
      if (!this.#holds(sid, followed)) {
        // Released while the file was being read: the watch this just put on it
        // is the only thing left of the reading, and it goes with it.
        tail.stop();
        return;
      }
      await this.#remember(followed);
      followed.standing = "ready";
      // Told whatever the file said. What the fold settled may be nothing, and
      // the reading being finished is itself a value of the row
      // (`session_status`), so a file that said nothing is still news.
      this.deps.onFacts(sid);
    } catch {
      // The reading could not be made. What it was taken up from goes, since
      // an entry this build read back but could not restore would fail the
      // same way every time it was read; the file itself is then read again
      // from its beginning, and a failure that came from the entry is gone
      // with it. The fold is emptied of whatever the failed reading put there,
      // and the tail is stopped rather than left reading for nobody.
      followed.tail?.stop();
      followed.tail = undefined;
      followed.path = undefined;
      followed.fold.reset();
      followed.standing = "absent";
      this.#reset(followed);
      void this.deps.cache?.drop(path);
      if (this.#holds(sid, followed) && !followed.frozen) {
        this.#lookAgain(sid, followed, false);
      }
    }
  }

  /** Where the session's transcript is, or nothing for now. A lookup that
   * fails says the same as one that finds nothing: the file is not there to be
   * read, and it will be looked for again. */
  async #find(sid: Sid): Promise<string | undefined> {
    try {
      return await this.deps.pathOf(sid);
    } catch {
      return undefined;
    }
  }

  /** The file is not there to be read. It is looked for again at the pace the
   * tail confirms a file at (DESIGN §4.2), for as long as something holds the
   * session: the wait for a file that has not been written is what a tail on
   * an absent file covers with its poll, and a session whose file this cannot
   * yet name is covered the same way, one level up. What the next look opens
   * is what `ready` waits on from then on, so whoever states a value derived
   * from the file waits for the whole of it. */
  #lookAgain(sid: Sid, followed: Followed, appeared: boolean): void {
    followed.timer = setTimeout(() => {
      followed.timer = undefined;
      followed.ready = this.#open(sid, followed, appeared);
    }, this.deps.pollMs ?? CONFIRM_POLL_MS);
  }

  /** Let go of what an entry runs: the tail, or the wait for a file. */
  #let(followed: Followed): void {
    followed.tail?.stop();
    if (followed.timer !== undefined) clearTimeout(followed.timer);
    followed.timer = undefined;
  }

  /** Whether this is still the reading that session is being followed by. A
   * release during an await takes the entry out, and a hold after it puts a
   * different one in; neither is this one. */
  #holds(sid: Sid, followed: Followed): boolean {
    return this.#followed.get(sid) === followed;
  }

  /** Write down where the reading has reached, so the next one starts there. */
  async #remember(followed: Followed): Promise<void> {
    const path = followed.path;
    const tail = followed.tail;
    if (path === undefined || tail === undefined) return;
    await this.deps.cache?.save(
      path,
      tail.offset,
      followed.fold.held,
      followed.reading.held,
      followed.recent,
    );
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
  #appended(sid: Sid, followed: Followed, appended: Appended): void {
    const changed = foldAll(followed.fold, appended.lines);
    this.deps.publish(`transcript:${sid}`, {
      sid,
      lines: [...appended.lines],
      start: appended.start,
      end: appended.end,
      size: appended.size,
    });
    const items = this.#keep(followed, appended);
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
  #keep(followed: Followed, chunk: Appended): readonly Item[] {
    const items = followed.reading.readAll(positioned(chunk.lines, chunk.start));
    followed.recent.push(...items);
    if (followed.recent.length > ITEMS_SNAPSHOT) {
      followed.recent.splice(0, followed.recent.length - ITEMS_SNAPSHOT);
    }
    return items;
  }

  /** The file is not the one that was being read, so neither the reading nor
   * what it produced describes it. */
  #reset(followed: Followed): void {
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
  /** Settled once the file has been looked for and, where found, read. */
  ready: Promise<void>;
  /** What the fold is worth right now, as `peers.session_status` states it. */
  standing: SessionStatusStanding;
  /** Whether two or more processes are writing the file, in which case nothing
   * of it is read and the last trusted value is what stands. */
  frozen: boolean;
  path?: string;
  tail?: TranscriptTail;
  /** The next look for a file that was not there, while nothing is read. */
  timer?: ReturnType<typeof setTimeout>;
}

function foldAll(fold: TranscriptFold, lines: readonly string[]): boolean {
  let changed = false;
  for (const line of lines) {
    if (fold.line(line)) changed = true;
  }
  return changed;
}
