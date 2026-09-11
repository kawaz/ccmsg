import type { AuthRecord, InstanceId } from "@ccmsg/protocol";
import type { Requester } from "../dispatch/index.ts";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";
import type { AuthRecords } from "./records.ts";

/** `auth.records` as the topic mechanism sees it (DR-0001 §2.6).
 *
 * The records are here whether anyone is subscribed or not — they are what
 * authenticates a person, not a watch on something — so there is nothing to
 * start or stop. What subscription decides is only who is told when one
 * changes.
 *
 * The whole set is the snapshot. The topic is `element`-granular, so a frame
 * carries the entries that moved and a subscriber folds them into what it
 * holds; a peer joining folds the lot, which is how a returning instance
 * catches up on what it missed. */
export class AuthTopic implements UpstreamResource {
  constructor(
    private readonly self: InstanceId,
    private readonly records: AuthRecords,
  ) {}

  start(): void {}
  stop(): void {}

  snapshot(_topic: string, _conn: Requester): readonly TopicValue[] {
    const data: { records: AuthRecord[] } = { records: this.records.all() };
    return [{ instance: this.self, data }];
  }
}
