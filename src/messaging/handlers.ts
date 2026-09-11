import type { Delivery } from "./delivery.ts";
import type { Notify } from "./notify.ts";

/** The ops that reach the messaging plane. They carry no logic of their own:
 * dispatch has validated and allowed the call, so each handler is the domain's
 * own entry point under the contract's name. */
export function messagingHandlers(delivery: Delivery, notify: Notify) {
  return {
    "message.send": delivery.send,
    "notify.send": notify.send,
    "say.post": notify.post,
    "say.unread.clear": notify.markRead,
  };
}
