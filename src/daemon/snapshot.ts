import type { InstanceId } from "@ccmsg/protocol";
import type { Conn } from "./control.ts";
import { CommandError } from "./link.ts";

/** What one instance opened a topic with, as the frame carried it.
 *
 * The pair rather than the payload alone, because two instances state the same
 * topic name: a payload with the name of its author taken off could not be told
 * from the other's, and which instance said it is half of what a cluster read
 * answers. */
export interface Snapshot {
  readonly instance: InstanceId;
  readonly data: unknown;
}

/** How long a read waits for the instances it expects to hear from.
 *
 * It bounds the wait for a peer that is listed as reachable and does not
 * answer — a link that went down between the greeting and the subscribe. The
 * instances that did answer are what the caller gets, so the budget costs a
 * slow peer's entry rather than the whole read. */
export const SNAPSHOT_BUDGET_MS = 3_000;

/** The fields a frame is read by. Named rather than indexed so the reads are
 * field accesses on a shape, which is what they are: the words are the
 * envelope's own (§ the topic frame), and none of them is a judgement. */
interface Frame {
  readonly ev?: unknown;
  readonly topic?: unknown;
  readonly instance?: unknown;
  readonly data?: unknown;
}

/** What a greeting answered, as the two fields a cluster read needs of it. */
interface Greeted {
  readonly instance?: unknown;
  readonly instances?: unknown;
}

/** Subscribe to a topic, take the value each expected instance states, and
 * leave.
 *
 * A subscription opens with one `snapshot: true` frame per instance that has a
 * value (§6.2), so the current value of a topic is read by subscribing and
 * stopping at the frames rather than by an op of its own. The local instance's
 * frame is deferred behind the acknowledgement and is therefore already on the
 * wire; the relayed ones are what the budget is for.
 *
 * The opening frame is the whole of what its instance holds, whichever kind of
 * topic it is: a `per_instance_whole` one states that instance's reading
 * entire, and an `element` one opens with every row it has rather than with the
 * rows that just changed. So one frame per instance is a complete read, and
 * nothing after it is waited for — the first frame from every expected instance
 * ends it. */
export async function snapshots(
  conn: Conn,
  topic: string,
  expected: readonly InstanceId[],
  budgetMs: number = SNAPSHOT_BUDGET_MS,
): Promise<Snapshot[]> {
  const ack = await conn.ask({ op: "topic.subscribe", topic });
  if (ack["ok"] !== true) {
    const error = ack["error"] as { code?: string; msg?: string } | undefined;
    throw new CommandError(
      (error?.code as CommandError["code"] | undefined) ?? "internal_error",
      error?.msg ?? `${topic} を購読できませんでした`,
    );
  }
  const held = new Map<InstanceId, unknown>();
  const wanted = new Set(expected);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const OVER = Symbol("over");
  const budget = new Promise<typeof OVER>((resolve) => {
    timer = setTimeout(() => resolve(OVER), budgetMs);
  });
  try {
    while (wanted.size > 0) {
      // Raced rather than cancelled: a frame that never comes is one this
      // waits out, and the connection is closed by the caller either way.
      const next = await Promise.race([conn.next(), budget]);
      if (next === OVER) break;
      const frame: Frame = next;
      if (frame.ev !== "topic" || frame.topic !== topic) continue;
      const from = frame.instance;
      if (typeof from !== "string") continue;
      held.set(from, frame.data);
      wanted.delete(from);
    }
  } finally {
    clearTimeout(timer);
  }
  return [...held].map(([instance, data]) => ({ instance, data }));
}

/** The instances a greeting named, as the set a read of a cluster topic waits
 * for.
 *
 * `all` is every instance the answering one can currently reach, itself
 * included: an unreachable peer has nothing to send and waiting for it would
 * spend the whole budget. Without it the read is about this instance alone,
 * which is the one that is certain to answer. */
export function expectedInstances(greeting: Record<string, unknown>, all: boolean): InstanceId[] {
  const greeted: Greeted = greeting;
  const self = greeted.instance;
  const here = typeof self === "string" ? [self] : [];
  if (!all) return here;
  const listed = greeted.instances;
  if (!Array.isArray(listed)) return here;
  const reachable = listed
    .filter((one): one is { id: string; reachable?: boolean } => {
      if (typeof one !== "object" || one === null) return false;
      const row = one as { id?: unknown; reachable?: unknown };
      return typeof row.id === "string" && row.reachable !== false;
    })
    .map((one) => one.id);
  return [...new Set([...here, ...reachable])];
}
