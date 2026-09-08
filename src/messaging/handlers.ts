import type { Delivery } from "./delivery.ts";

/** The op that reaches delivery. It carries no logic of its own: dispatch has
 * validated and allowed the call, so the handler is the domain's own entry
 * point under the contract's name. */
export function messagingHandlers(delivery: Delivery) {
  return { message_send: delivery.send };
}
