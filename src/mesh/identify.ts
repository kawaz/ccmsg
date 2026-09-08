import type { InstanceId } from "@ccmsg/protocol";
import { MESH_VER, randomId } from "./keys.ts";
import { probeEndpoint, type ProbeBody } from "./wire.ts";

/** How long a probe may take to come back (mesh-self-identification §5.6).
 *
 * The document says "a few seconds" and gives the reason: an endpoint that does
 * not answer is a configuration mistake, and waiting longer does not make it
 * less of one. Under this instance's relaxation (§7.1, DV-Q11) it is also what
 * separates "asleep" from "answering", so it bounds startup rather than
 * deciding correctness. */
export const PROBE_TIMEOUT_MS = 3_000;

/** Why self-identification refused to settle an identity.
 *
 * Its own class so startup can refuse the same way a broken config does (§8.3,
 * DV-Q9): the endpoint list is a setting, and a list this instance cannot find
 * itself in is a setting that is wrong. */
export class SelfIdentificationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SelfIdentificationError";
  }
}

/** The table of probes in flight, and the endpoint each was sent to.
 *
 * The receiving side of the probe is this instance's own HTTP route, so the
 * table is read by a route and written by the dispatch of the probes. It is
 * destroyed when the run finishes (§7.3): what the exercise leaves behind is
 * `self` and nothing else. */
export class SelfIdentification {
  #sent = new Map<string, InstanceId>();
  readonly #matched = new Set<InstanceId>();

  /** A probe arrived here. Answering is unconditional and holds no state: the
   * comparison is the sender's, and this instance is the sender for exactly one
   * of the probes it is currently answering (§5.1). */
  accept(token: string): void {
    const sentTo = this.#sent.get(token);
    if (sentTo !== undefined) this.#matched.add(sentTo);
  }

  /** Settle `self` by asking every endpoint who it is, including this one.
   *
   * The probe to ourselves is not an optimisation to skip: it is the reason a
   * peer replaying its own probe back at us fails to mislead us — the reply and
   * our own probe both land, the count reaches two, and startup refuses rather
   * than settling on the wrong endpoint (§4.2). */
  async settle(peers: readonly InstanceId[]): Promise<InstanceId> {
    if (peers.length === 0) {
      throw new SelfIdentificationError("a mesh instance settles itself against its peer list");
    }
    this.#sent = new Map(peers.map((peer) => [randomId(), peer]));
    const unreachable: InstanceId[] = [];
    await Promise.all(
      [...this.#sent].map(async ([token, peer]) => {
        if (!(await this.#probe(peer, token))) unreachable.push(peer);
      }),
    );
    // What was matched, and what is left over once the endpoints that never
    // answered are set aside. A peer that is asleep is the normal state of this
    // mesh rather than a mistake, so it is taken out of the count instead of
    // ending the start (§7.1, DV-Q11). The safety of §4.2 rests only on our own
    // probe reaching us, which no peer's absence affects.
    const matched = [...this.#matched];
    // 5. the table goes, whatever the outcome (§7.3).
    this.#sent = new Map();
    this.#matched.clear();
    if (matched.length === 1) return matched[0] as InstanceId;
    const reached = peers.filter((peer) => !unreachable.includes(peer));
    if (matched.length === 0) {
      throw new SelfIdentificationError(
        `none of the ${reached.length} endpoint(s) this instance reached is itself: ` +
          `${reached.join(", ") || "(none answered)"}`,
      );
    }
    throw new SelfIdentificationError(
      `${matched.length} endpoints are this instance, and which of them is its name ` +
        `cannot be decided here: ${matched.join(", ")}`,
    );
  }

  /** Whether the endpoint answered. What it answered does not matter: the
   * comparison happens where the probe lands, not in its reply. */
  async #probe(peer: InstanceId, token: string): Promise<boolean> {
    const body: ProbeBody = { ver: MESH_VER, token };
    try {
      const response = await fetch(probeEndpoint(peer), {
        method: "POST",
        // Closed after the one round trip it is: a probe is sent once at
        // startup, and a pooled connection kept open for it would outlive the
        // exercise and hold the listener at the far end.
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
