import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/** M3: every periodic timer is listed, and each has a reason (daemon-v2 §1.1 /
 * §11.3).
 *
 * A timer is the shape a poll takes when nobody could name a better trigger, so
 * the design's rule is not "no timers" but "no timer whose period nobody can
 * justify". The list below is that justification, and the scan is what makes it
 * a list rather than a claim: a new `setInterval` fails this test until it is
 * added here with its reason. */
const PERIODIC: Record<string, string> = {
  // The directory watch tells us about a change the moment it happens; this
  // runs behind it to catch what a watch on a directory can miss, which is why
  // its period is a confirmation interval rather than a sampling rate.
  "sessions/harness.ts": "confirmation poll behind the sessions/ watch",
  // The same shape one layer down: the tail follows a file that is appended to,
  // and this confirms what the watch may not have reported.
  "transcript/tail.ts": "confirmation poll behind the transcript tail",
  // The one timer that is not a confirmation: a middlebox can drop a connection
  // without telling either end, and there is no event for something that did
  // not happen. Its period is chosen rather than derived, and says so where it
  // is defined (mesh-peer-auth §8.3).
  "mesh/mesh.ts": "the mesh heartbeat, which detects a silently dropped link",
};

const SRC = new URL("../src/", import.meta.url).pathname;

describe("every periodic timer is listed with its reason (M3)", () => {
  test("the files that run one are exactly the ones listed", async () => {
    const found: string[] = [];
    for (const path of new Glob("**/*.ts").scanSync(SRC)) {
      const source = await Bun.file(SRC + path).text();
      if (/\bsetInterval\(/.test(source)) found.push(path);
    }
    expect(found.sort()).toEqual(Object.keys(PERIODIC).sort());
  });

  test("each reason says what the period is for, not merely that there is one", () => {
    for (const reason of Object.values(PERIODIC)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
