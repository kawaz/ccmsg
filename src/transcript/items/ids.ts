import type { DumpIdEntry, DumpIds } from "@ccmsg/protocol";
import { fields as fieldsOf, type Item } from "./item.ts";

/** The ids the items carried, gathered once.
 *
 * An id says how to point at something, not what a line is, so the ledger is
 * kept beside the items rather than among them — as a type it would put the
 * same agent in the dump twice, once as what happened and once as a name.
 *
 * It is what a reader descends by: the agent that did the thing worth copying
 * is named here, and dumping that agent is the same request with this id as
 * its subject. So it is relative to the subject, listing the agents this one
 * started rather than the one it is. */
export function ledger(items: readonly Item[]): DumpIds {
  const found = new Map<string, DumpIdEntry>();
  const note = (entry: DumpIdEntry): void => {
    // The kind is one of a fixed set of words and carries no `|` (contract,
    // `DumpIdKind`), so the first one is where the key divides — an id, which
    // may be anything a harness wrote, cannot make two pairs read alike.
    const at = `${entry.kind}|${entry.id}`;
    const known = found.get(at);
    // A later sighting of the same id is a later state of it — an agent seen
    // running and then finished — so what it says is taken over what was known
    // before, field by field, and neither sighting has to be the complete one.
    found.set(at, known === undefined ? entry : { ...known, ...entry });
  };
  for (const item of items) {
    const fields = fieldsOf(item);
    const label =
      string(fields["name"]) ?? string(fields["harness_name"]) ?? string(fields["description"]);
    const status = string(fields["status"]);
    const duration = integer(fields["duration_ms"]);
    const agent = string(fields["agent_id"]);
    if (agent !== undefined) {
      note({
        kind: "agent",
        id: agent,
        ...(label === undefined ? {} : { label }),
        ...(status === undefined ? {} : { status }),
        ...(duration === undefined ? {} : { duration_ms: duration }),
      });
    }
    const task = string(fields["task_id"]);
    if (task !== undefined) {
      note({ kind: "task", id: task, ...(label === undefined ? {} : { label }) });
    }
    const call = string(fields["tool_use_id"]);
    if (call !== undefined) note({ kind: "tool_use", id: call, label: item.type });
    const message = string(fields["msg_id"]);
    if (message !== undefined) note({ kind: "msg", id: message });
    // Only a session is addressed by a sid. The other correspondences name
    // their counterpart too, but a teammate is named by a name — a thing the
    // ledger has no kind for, and one nothing can be dumped by — so putting it
    // here would list something a reader cannot descend into.
    if (item.type.startsWith("message.session")) {
      for (const name of ["from", "to"]) {
        const peer = string(fields[name]);
        if (peer !== undefined) note({ kind: "sid", id: peer });
      }
    }
    const cron = string(fields["cron_id"]);
    if (cron !== undefined) note({ kind: "cron", id: cron });
  }
  return [...found.values()];
}

function string(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function integer(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}
