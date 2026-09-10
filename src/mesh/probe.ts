import type { Endpoint } from "@ccmsg/protocol";
import { MESH_VER, randomId } from "./keys.ts";
import { probeEndpoint, type ProbeBody } from "./wire.ts";

/** How long a probe may take to come back.
 *
 * An endpoint that does not answer is either asleep or misconfigured, and
 * waiting longer tells the two apart no better. It bounds startup rather than
 * deciding correctness: only the probe that lands back here decides anything. */
export const PROBE_TIMEOUT_MS = 3_000;

/** The configured endpoints do not say which instance this is.
 *
 * Its own class so startup can refuse the same way a broken config does (§8.3,
 * DV-Q9): a list that names this instance zero times, or twice, is a list that
 * cannot be acted on. */
export class SelfEndpointError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SelfEndpointError";
  }
}

/** What one round of probes settled. */
export interface PeerReport {
  /** The one configured endpoint that turned out to be this instance. */
  readonly self: Endpoint;
  /** The endpoints that did not answer. Recorded and not refused: a peer that
   * is asleep is the normal state of this mesh (§7.1, DV-Q11). */
  readonly unreachable: readonly Endpoint[];
}

/** The probes in flight, and the endpoint each was sent to.
 *
 * This is where an instance learns which of the configured endpoints it is
 * (mesh-self-identification §5). A `token` is minted per endpoint and sent
 * there; the one that arrives back at this process was sent to this process,
 * and the endpoint it was addressed to is therefore this instance's own.
 *
 * Every endpoint is probed, this instance's own included: the probe to
 * ourselves is the one that always lands, which is what makes a peer echoing
 * a stolen token show up as two matches rather than as a wrong answer (§4.2).
 *
 * The table is destroyed when the run finishes: what the exercise leaves behind
 * is the settled endpoint and nothing else (§7.3). */
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

  /** Probe every configured endpoint and settle which one is this instance.
   *
   * An endpoint that did not answer is left out of the count rather than
   * refused, so a mesh whose other host is asleep still starts (DV-Q11): the
   * count only ever decides on endpoints that answered, and the probe to
   * ourselves always does. */
  async identify(peers: readonly Endpoint[]): Promise<PeerReport> {
    const targets = [...new Set(peers)];
    this.#sent = new Map(targets.map((target) => [randomId(), target]));
    const unreachable: Endpoint[] = [];
    await Promise.all(
      [...this.#sent].map(async ([token, target]) => {
        if (!(await this.#probe(target, token))) unreachable.push(target);
      }),
    );
    const matched = [...this.#matched];
    this.#sent = new Map();
    this.#matched.clear();
    if (matched.length !== 1) {
      throw new SelfEndpointError(
        matched.length === 0
          ? `none of the configured endpoints reached this instance: ${targets.join(", ")}`
          : `several configured endpoints reach this instance: ${matched.join(", ")}`,
      );
    }
    return { self: matched[0] as Endpoint, unreachable };
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
