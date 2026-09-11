import { hostname } from "node:os";
import type { Endpoint, InstanceId, InstanceInfo } from "@ccmsg/protocol";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";

/** What the `instances` topic reads: the mesh as this instance sees it, which
 * is the same view `hello` answers with. */
export interface MeshView {
  instances(): InstanceInfo[];
}

/** The cluster as one instance sees it, itself included.
 *
 * An instance with no mesh is a cluster of one and says so: it is reached at
 * whatever it serves, which is a row without an endpoint when that is the unix
 * socket alone rather than no row at all (contract, `InstanceInfo`).
 *
 * The same answer feeds `hello` and the topic, from here rather than from two
 * places: a greeting and a subscription that disagreed about who is in the
 * cluster would be one instance stating two views of itself. */
export function clusterView(
  self: InstanceId,
  endpoint: Endpoint | undefined,
  mesh: MeshView | undefined,
): InstanceInfo[] {
  return (
    mesh?.instances() ?? [
      {
        id: self,
        ...(endpoint === undefined ? {} : { endpoint }),
        host: hostname(),
        reachable: true,
      },
    ]
  );
}

/** The `instances` topic (§7.5).
 *
 * A link going down reaches a subscriber where it is already listening, rather
 * than only on its next greeting. The value is whole per instance: `reachable`
 * is one instance's reading of every link it has, taken together, and two
 * instances may legitimately disagree about the same link — so a frame states
 * one sender's view entire and leaves every other sender's alone.
 *
 * Nothing is started or stopped by a subscription. The view exists because the
 * mesh exists, and reading it costs a walk over the configured peers (§6.3:
 * what subscription drives is a watch, and there is none here). */
export class Instances implements UpstreamResource {
  constructor(
    private readonly deps: {
      readonly self: InstanceId;
      readonly endpoint?: Endpoint;
      readonly mesh?: MeshView;
      readonly publish: (topic: string, data: unknown) => void;
    },
  ) {}

  view(): InstanceInfo[] {
    return clusterView(this.deps.self, this.deps.endpoint, this.deps.mesh);
  }

  /** State the view, which the mesh asks for whenever a link moves. A frame
   * equal to the last one goes no further than the suppression every topic
   * shares (M5), so restating it costs nothing when nothing moved. */
  refresh(): void {
    this.deps.publish("instances", { instances: this.view() });
  }

  start(): void {}

  stop(): void {}

  snapshot(): readonly TopicValue[] {
    return [{ instance: this.deps.self, data: { instances: this.view() } }];
  }
}
