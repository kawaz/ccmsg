import type { EgressClock, EgressOptions } from "../src/topics/index.ts";

/** A clock a case moves by hand: nothing is armed until it is asked for, and
 * nothing fires until the time it was armed for has been reached.
 *
 * `advance` runs whatever the elapsed time released, in the order it was armed,
 * so a case states the passage of time rather than waiting it out. */
export function manualClock() {
  let at = 0;
  let next = 1;
  const armed = new Map<number, { readonly due: number; readonly run: () => void }>();
  const clock: EgressClock = {
    now: () => at,
    schedule: (afterMs, run) => {
      const id = next++;
      armed.set(id, { due: at + afterMs, run });
      return () => {
        armed.delete(id);
      };
    },
  };
  return {
    clock,
    get pending(): number {
      return armed.size;
    },
    advance(ms: number): void {
      at += ms;
      // Read what is due before any of it runs: a flush may arm the next one,
      // and that one belongs to the time it was armed for rather than to this
      // call.
      const due = [];
      for (const [id, entry] of armed) {
        if (entry.due <= at) due.push([id, entry] as const);
      }
      for (const [id, entry] of due) {
        armed.delete(id);
        entry.run();
      }
    },
  };
}

/** A clock under which every frame goes out as it is raised.
 *
 * For the cases that are about something else — suppression, granularity, who
 * may hear a topic — where gathering frames would only make each case state the
 * passage of time it does not care about. Time moves a whole period per reading,
 * so the queue is never the reason a frame is not on the wire yet. */
export function unthrottled(): EgressOptions {
  let at = 0;
  return {
    clock: {
      now: () => (at += 1000),
      schedule: () => () => {},
    },
  };
}
