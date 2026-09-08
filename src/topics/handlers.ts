import type { TopicSubscribeArgs, TopicSubscribeResult } from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../dispatch/index.ts";
import type { SubscribeOutcome, Topics } from "./topics.ts";

/** The two ops that reach the topic mechanism. They carry no logic: dispatch
 * has already validated and allowed the call, so each one names a topic, hands
 * it to `Topics`, and turns the outcome into the contract's own answer. */
export function topicHandlers(topics: Topics) {
  return {
    topic_subscribe: (input: HandlerInput): TopicSubscribeResult => {
      const topic = topicOf(input);
      answer(topics.subscribe(input.conn, topic), topic);
      return { topic };
    },
    topic_unsubscribe: (input: HandlerInput): TopicSubscribeResult => {
      const topic = topicOf(input);
      answer(topics.unsubscribe(input.conn, topic), topic);
      return { topic };
    },
  };
}

/** Safe to read: the op's schema accepted the frame before the handler ran. */
function topicOf(input: HandlerInput): string {
  return (input.args as unknown as TopicSubscribeArgs).topic;
}

function answer(outcome: SubscribeOutcome, topic: string): void {
  if (outcome === "ok") return;
  throw new OpError(outcome, refusal(outcome, topic));
}

function refusal(outcome: Exclude<SubscribeOutcome, "ok">, topic: string): string {
  switch (outcome) {
    case "topic_unknown":
      return `no such topic: ${topic}`;
    case "forbidden":
      return `${topic} is not open to this connection`;
    case "capability_unavailable":
      return `${topic} needs a capability this instance does not have`;
  }
}
