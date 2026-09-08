import type {
  InstanceId,
  Notification,
  NotifySendArgs,
  NotifySendResult,
  SayMarkReadArgs,
  SayMarkReadResult,
  SayPostArgs,
  SayPostResult,
  Sid,
  Timestamp,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../dispatch/index.ts";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";

/** The one topic a notification reaches a watcher on. */
const NOTIFY = "notify";

export interface NotifyDeps {
  readonly self: InstanceId;
  /** How a session is shown. The contract has the issuing instance resolve it,
   * so the label is decided here rather than carried in the arguments. */
  readonly label: (sid: Sid) => string;
  /** The one way a value reaches subscribers (§6.1). No `to`: a notification is
   * for whoever is watching, not for one session. */
  readonly publish: (topic: string, data: unknown, instance: InstanceId) => void;
}

/** The `notify` topic and the three ops that speak on it.
 *
 * One object for all three because they are one thing seen from two sides: a
 * line reaching a person watching. `notify_send` is somebody telling a person
 * about a session; `say_post` is a session saying that it just spoke. Both end
 * as the same frame, which is what keeps "a notification" from meaning two
 * shapes depending on which op raised it.
 *
 * The topic is `event` granularity (§6.2): nothing is held, so there is no
 * snapshot and no suppression — two identical notifications are two things
 * that happened. */
export class Notify implements UpstreamResource {
  /** Sessions that have spoken and not been heard. Instance state the contract
   * lets a restart forget, so it lives here and nowhere on disk. */
  readonly #unread = new Set<Sid>();

  constructor(private readonly deps: NotifyDeps) {}

  /** `notify_send`. The subject is the argument when it names one and the
   * caller otherwise, so a session notifying about itself says only the text. */
  send = (input: HandlerInput): NotifySendResult => {
    const args = input.args as unknown as NotifySendArgs;
    this.#announce(args.sid ?? this.#caller(input), args.text);
    return {};
  };

  /** `say_post`. What was said is already in the caller's transcript, so this
   * pushes the occurrence and raises the unread mark; the instance keeps no log
   * of its own. The op is open to sessions alone, so the subject is the caller
   * and there is nothing to address. */
  post = (input: HandlerInput): SayPostResult => {
    const args = input.args as unknown as SayPostArgs;
    const sid = this.#caller(input);
    const posted_at = this.#announce(sid, args.text);
    this.#unread.add(sid);
    return { posted_at };
  };

  /** `say_mark_read`. One session's mark, or every one when none is named. */
  markRead = (input: HandlerInput): SayMarkReadResult => {
    const { sid } = input.args as unknown as SayMarkReadArgs;
    if (sid === undefined) this.#unread.clear();
    else this.#unread.delete(sid);
    return {};
  };

  /** The sessions that have spoken unheard. Nothing in this generation of the
   * contract carries the mark on the wire, so this is how the instance's own
   * side reads what `say_mark_read` clears. */
  unread(): readonly Sid[] {
    return [...this.#unread];
  }

  // --- UpstreamResource (§6.3)

  /** Nothing upstream to run: a notification exists because an op raised it. */
  start(): void {}

  stop(): void {}

  /** An event topic has no current value, so a subscriber starts at the next
   * thing that happens (§6.2). */
  snapshot(): readonly TopicValue[] {
    return [];
  }

  #announce(sid: Sid, text: string, now: Timestamp = Date.now()): Timestamp {
    const notification: Notification = {
      sid,
      sid_label: this.deps.label(sid),
      text,
      sent_at: now,
    };
    this.deps.publish(NOTIFY, notification, this.deps.self);
    return now;
  }

  /** The session the caller is. A person's connection names none, which is why
   * `notify_send` takes the subject as an argument — one that omits it from a
   * connection with no session has named nobody for the notification to be
   * about. */
  #caller(input: HandlerInput): Sid {
    const sid = input.identity?.sid;
    if (sid === undefined) {
      throw new OpError("bad_request", "a notification is about a session, and this names none");
    }
    return sid;
  }
}
