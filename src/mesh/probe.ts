import type { Endpoint } from "@ccmsg/protocol";
import { MESH_VER, randomId } from "./keys.ts";
import { probeEndpoint, type ProbeBody } from "./wire.ts";

/** How long a probe may take to come back.
 *
 * An endpoint that does not answer is either asleep or misconfigured, and
 * waiting longer tells the two apart no better. It bounds startup rather than
 * deciding correctness: only the probe this instance sends itself decides
 * anything. */
export const PROBE_TIMEOUT_MS = 3_000;

/** The configured endpoints do not describe this instance.
 *
 * Its own class so startup can refuse the same way a broken config does (§8.3,
 * DV-Q9): `self` is a setting, and one that does not reach this process is a
 * setting that is wrong. */
export class SelfEndpointError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SelfEndpointError";
  }
}

/** What one round of probes found. */
export interface PeerReport {
  /** The configured endpoints that turned out to be this instance — `self`,
   * and any alias of it a peer list happens to name. They are not dialled: a
   * link to ourselves is not a link. */
  readonly ours: readonly Endpoint[];
  /** The endpoints that did not answer. Recorded and not refused: a peer that
   * is asleep is the normal state of this mesh (§7.1, DV-Q11). */
  readonly unreachable: readonly Endpoint[];
}

/** The probes in flight, and the endpoint each was sent to.
 *
 * Since `self` is configured (DR-0001 §2.7), this no longer settles an identity:
 * it checks the setting. The probe to `self` has to come back here, which is
 * what catches a `self` that names somebody else, and the rest of the list is
 * probed to record what can be reached before anything is dialled.
 *
 * The table is destroyed when the run finishes: what the exercise leaves behind
 * is the report and nothing else (§7.3). */
export class PeerProbe {
  #sent = new Map<string, Endpoint>();
  readonly #matched = new Set<Endpoint>();

  /** A probe arrived here. Answering is unconditional and holds no state: the
   * comparison is the sender's, and this instance is the sender for exactly one
   * of the probes it is currently answering (§5.1). */
  accept(token: string): void {
    const sentTo = this.#sent.get(token);
    if (sentTo !== undefined) this.#matched.add(sentTo);
  }

  /** Ask `self` and every peer who answers there, and refuse to start if the
   * endpoint this instance calls its own is somebody else's. */
  async verify(self: Endpoint, peers: readonly Endpoint[]): Promise<PeerReport> {
    const targets = [...new Set([self, ...peers])];
    this.#sent = new Map(targets.map((target) => [randomId(), target]));
    const unreachable: Endpoint[] = [];
    await Promise.all(
      [...this.#sent].map(async ([token, target]) => {
        if (!(await this.#probe(target, token))) unreachable.push(target);
      }),
    );
    const ours = [...this.#matched];
    this.#sent = new Map();
    this.#matched.clear();
    if (!ours.includes(self)) {
      throw new SelfEndpointError(
        unreachable.includes(self)
          ? `self is ${self}, which did not answer this instance's probe`
          : `self is ${self}, which answers as another instance`,
      );
    }
    return { ours, unreachable };
  }

  /** Whether the endpoint answered. What it answered does not matter: the
   * comparison happens where the probe lands, not in its reply. */
  async #probe(target: Endpoint, token: string): Promise<boolean> {
    const body: ProbeBody = { ver: MESH_VER, token };
    try {
      const response = await fetch(probeEndpoint(target), {
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
