import type { TranscriptItem } from "@ccmsg/protocol";

/** One classified item, at the shape the contract states.
 *
 * The contract is the authority on what an item is, and its schema carries a
 * type, so there is nothing to restate here: what the daemon holds and what
 * travels are the same value, and a field that drifted would fail to compile
 * rather than to validate. */
export type Item = TranscriptItem;

/** An item's fields read by name.
 *
 * The type is a union of one object per item type, which is what makes it
 * precise when an item is built and useless when one is read: a drawing asks
 * every item for `role` or `agent_id` and only some types have either. This is
 * the one place that gap is crossed, so a reader names a field once instead of
 * narrowing a union of fifty members it has no discriminant for. */
export function fields(item: Item): Record<string, unknown> {
  return item as unknown as Record<string, unknown>;
}
