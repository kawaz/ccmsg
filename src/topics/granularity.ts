import type { TopicKind } from "@ccmsg/protocol";

/** How a frame on a topic relates to the value before it (daemon-v2 §6.2).
 *
 * This belongs in the contract, alongside the roles and capability of
 * `TOPIC_ATTRIBUTES`: it is a property of the topic, not of this daemon, and
 * holding it here makes it the second place the fact lives. It is here until
 * the contract carries it.
 *
 * `per_instance_whole` is the one that mesh rests on: the frame replaces what
 * its originating `instance` last said and leaves every other instance's share
 * alone, which is why the whole values of several instances share one topic
 * name without colliding. `event` is the one with no value behind it at all —
 * a notification matters when it happens, so there is nothing to snapshot to a
 * later subscriber and nothing for a repeat to be a repeat of. The rest
 * describe how a subscriber folds a frame into the value it holds.
 *
 * Producing a value at the right granularity is the domain's job, and so is
 * stating the current one: the topic mechanism holds no value at all, only the
 * form of the last frame it sent under each topic, which is what suppression
 * compares against (§3.3). The single thing it takes from this table is
 * whether that comparison applies. */
export type Granularity = "whole" | "per_instance_whole" | "element" | "append" | "event";

/** Whether a repeat on this topic is worth dropping. False for `event`, whose
 * frames are occurrences: two identical ones are two things that happened. */
export function isSuppressed(kind: TopicKind): boolean {
  return TOPIC_GRANULARITY[kind] !== "event";
}

export const TOPIC_GRANULARITY = {
  peers: "per_instance_whole",
  agents: "per_instance_whole",
  session_errors: "per_instance_whole",
  session_status: "whole",
  llm_status: "whole",
  inbox: "element",
  notify: "event",
  llm_requests: "element",
  transcript: "append",
  kv: "element",
} as const satisfies Record<TopicKind, Granularity>;
