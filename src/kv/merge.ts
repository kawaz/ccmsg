import { LAST_LIVE_RETENTION_MS, type Timestamp } from "@ccmsg/protocol";

/** One key's state: the value it holds, or the record that it was removed.
 *
 * A removal is kept rather than dropped because two instances mirror this
 * store between themselves: an absence says nothing about whether a key was
 * never written or was deleted, so the deletion is a value of its own until it
 * is old enough that no mirror can still be carrying the write it undid. */
export interface Held {
  /** Absent exactly when the entry is a removal, which is the contract's own
   * rule for an entry (`KvEntry`). */
  value?: unknown;
  updated_at: Timestamp;
  deleted?: true;
}

/** How long a removal is remembered.
 *
 * The same window `last_live` keeps a session that stopped being seen: both
 * bound how long an instance that was away may be gone and still be told what
 * happened while it was, and having them differ would state two answers to one
 * question about the same mesh. */
export const TOMBSTONE_RETENTION_MS = LAST_LIVE_RETENTION_MS;

/** Whether a removal is old enough to forget. */
export function expired(held: Held, now: Timestamp): boolean {
  return held.deleted === true && now - held.updated_at > TOMBSTONE_RETENTION_MS;
}

/** Which of two states of one key stands.
 *
 * The later `updated_at` wins, which is the whole of what the contract
 * promises about a key two instances disagree on (`KvReadArgs`). A removal is
 * a write like any other and wins or loses by the same instant, which is what
 * keeps a delete from being undone by an older write that arrives after it.
 *
 * Two instants that are equal settle only as far as the contract does. A
 * removal beats a value, which both sides decide alike whichever of them is
 * asking; two different values written at the same millisecond are left as
 * each side holds them, because the only rules that would converge them —
 * preferring the local one, or ordering the values themselves — are either not
 * symmetric or not the contract's. The next write to the key settles it. */
export function mergeHeld(local: Held | undefined, remote: Held | undefined): Held | undefined {
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  if (local.updated_at !== remote.updated_at) {
    return local.updated_at > remote.updated_at ? local : remote;
  }
  return remote.deleted === true ? remote : local;
}

/** A namespace as it stands once a mirror of it has arrived. Neither side is
 * changed; what both hold afterwards is this. */
export function mergeNamespace(
  local: ReadonlyMap<string, Held>,
  remote: ReadonlyMap<string, Held>,
  now: Timestamp = Date.now(),
): Map<string, Held> {
  const merged = new Map<string, Held>();
  for (const key of new Set([...local.keys(), ...remote.keys()])) {
    const held = mergeHeld(local.get(key), remote.get(key));
    if (held === undefined || expired(held, now)) continue;
    merged.set(key, held);
  }
  return merged;
}
