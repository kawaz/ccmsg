import type {
  InstanceId,
  SessionApiError,
  SessionErrorEntry,
  SessionStatusSnapshot,
  Sid,
} from "@ccmsg/protocol";
import { canonical, within } from "../files/containment.ts";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";
import { topicParam } from "../topics/index.ts";
import type { TranscriptFacts } from "../transcript/index.ts";
import { workspaceFolders } from "./workspace.ts";

/** What the fold says stopped a session, read in one place.
 *
 * Three values rest on it: whether a live session is Waiting (§5.2), what
 * `session_errors` lists, and the `api_error` of `session_status:<sid>`. They
 * ask this rather than each reading the fold's field, so the three cannot come
 * to different answers about the same session (§7.4, M5). */
export function stoppedOn(facts: TranscriptFacts): SessionApiError | undefined {
  return facts.api_error;
}

/** The `session_status:<sid>` payload.
 *
 * Almost every field is the fold's, stated as the fold left it: one pass over
 * the transcript settles the error, the task list, the files it named and what
 * is running below it, and this assembles them rather than reading anything a
 * second time (M5).
 *
 * The two fields that are not the fold's are the ones the transcript does not
 * carry. `workspace_folders` is read from the editor's own workspace file, and
 * `external_files` needs a root to be outside of — a greeting's fact, not a
 * transcript's — so the paths the fold collected are filtered here, where the
 * root is known. A session that stated no root contributes none of them rather
 * than all of them: the list is the allowlist an `external` read is checked
 * against, so not knowing where the session works has to admit nothing. */
export function sessionStatusOf(
  sid: Sid,
  facts: TranscriptFacts,
  where: SessionWhere = {},
): SessionStatusSnapshot & {
  sid: Sid;
} {
  const stopped = stoppedOn(facts);
  const root = where.root === undefined ? undefined : canonical(where.root);
  return {
    sid,
    todos: [...facts.todos],
    workflows: [...facts.workflows],
    background: [...facts.background],
    teammates: [...facts.teammates],
    agent_tree: facts.agent_tree,
    external_files:
      root === undefined
        ? []
        : facts.named_files.filter((file) => !within(canonical(file.path), root)),
    workspace_folders: workspaceFolders(where.cwd),
    ...(stopped === undefined ? {} : { api_error: stopped }),
  };
}

/** Where a session works, as it greeted (§5.1). The same two values the file
 * surfaces are decided against, asked for here so that what `session_status`
 * says and what a read is admitted by come from one answer. */
export interface SessionWhere {
  readonly root?: string;
  readonly cwd?: string;
}

export interface SessionStatusDeps {
  readonly self: InstanceId;
  /** The sessions this instance can follow a transcript of: the ones that
   * greeted, since a greeting is the only thing that names a transcript path
   * (§5.1). A session it cannot follow has no error to fold. */
  readonly sessions: () => readonly Sid[];
  readonly facts: (sid: Sid) => TranscriptFacts;
  /** Where each session works, for the two fields the transcript does not
   * state. */
  readonly where: (sid: Sid) => SessionWhere;
  /** The tail behind a session's fold, asked for and let go by name. */
  readonly hold: (sid: Sid) => void;
  readonly release: (sid: Sid) => void;
  /** The one way a value reaches subscribers (§6.1). */
  readonly publish: (topic: string, data: unknown) => void;
}

/** The two topics the fold's error state feeds, and the tails they keep
 * running (§6.3).
 *
 * `session_errors` is one list for the instance and `session_status:<sid>` is
 * one session, so what they hold differs: the first wants every session's fold
 * and the second wants one. Both wants are the same mechanism — a subscription
 * arrives, the tails it needs are held, and the last subscription to go
 * releases them — which is why the two topics share one owner rather than
 * having a hold rule each. */
export class SessionStatus implements UpstreamResource {
  /** The topic names currently subscribed. */
  readonly #wanted = new Set<string>();
  /** The tails held for those subscriptions, one hold per session however many
   * topics want it. */
  readonly #held = new Set<Sid>();
  /** Holding and releasing a tail settles the fold, which reaches back here as
   * a change. The outer pass is left to finish and then runs again, so the
   * convergence happens once rather than in the middle of itself. */
  #converging = false;
  #pending = false;

  constructor(private readonly deps: SessionStatusDeps) {}

  // --- UpstreamResource (§6.3)

  start(topic: string): void {
    this.#wanted.add(topic);
    this.refresh();
  }

  stop(topic: string): void {
    this.#wanted.delete(topic);
    this.refresh();
  }

  snapshot(topic: string): readonly TopicValue[] {
    const data = this.value(topic);
    return data === undefined ? [] : [{ instance: this.deps.self, data }];
  }

  /** The tails follow the sessions and the subscriptions: what the fold now
   * says, and which sessions exist, are the two things that move either.
   *
   * Called by whoever changes one of them, rather than on a timer (M3). */
  refresh(): void {
    if (this.#converging) {
      this.#pending = true;
      return;
    }
    this.#converging = true;
    try {
      do {
        this.#pending = false;
        this.#hold();
      } while (this.#pending);
    } finally {
      this.#converging = false;
    }
    for (const topic of this.#wanted) {
      const data = this.value(topic);
      if (data !== undefined) this.deps.publish(topic, data);
    }
  }

  /** Whether a session's fold is being kept for these topics, which is how
   * "the subscription drives the resource" is observable from outside. */
  holding(sid: Sid): boolean {
    return this.#held.has(sid);
  }

  /** Every session this instance holds stopped on an error. A session that
   * recovers drops out rather than appearing with an empty error, so a client
   * that missed a frame converges on the next one. */
  errors(): { errors: SessionErrorEntry[] } {
    const errors: SessionErrorEntry[] = [];
    for (const sid of this.deps.sessions()) {
      const stopped = stoppedOn(this.deps.facts(sid));
      if (stopped !== undefined) errors.push({ sid, instance: this.deps.self, ...stopped });
    }
    return { errors };
  }

  /** What a topic of this owner currently says, for a snapshot and for a
   * change alike — built here and nowhere else, so the two cannot drift. */
  private value(topic: string): unknown {
    if (topic === "session_errors") return this.errors();
    const sid = topicParam(topic);
    return sid === undefined
      ? undefined
      : sessionStatusOf(sid, this.deps.facts(sid), this.deps.where(sid));
  }

  /** Bring the held tails in line with what the subscriptions need. */
  #hold(): void {
    const wanted = this.#wantedSessions();
    for (const sid of wanted) {
      if (this.#held.has(sid)) continue;
      this.#held.add(sid);
      this.deps.hold(sid);
    }
    for (const sid of this.#held) {
      if (wanted.has(sid)) continue;
      this.#held.delete(sid);
      this.deps.release(sid);
    }
  }

  #wantedSessions(): Set<Sid> {
    const wanted = new Set<Sid>();
    // One list for the instance means every session's fold; the list is what
    // the subscriber asked for, and it cannot be built from a subset of it.
    if (this.#wanted.has("session_errors")) {
      for (const sid of this.deps.sessions()) wanted.add(sid);
    }
    for (const topic of this.#wanted) {
      if (topic === "session_errors") continue;
      const sid = topicParam(topic);
      if (sid !== undefined) wanted.add(sid);
    }
    return wanted;
  }
}
