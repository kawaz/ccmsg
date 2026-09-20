import { parentPort, workerData } from "node:worker_threads";

/** Matching a person's regular expression, off the thread that answers ops.
 *
 * A `RegExp` runs to its end once it has started — JS states no way to stop
 * one — so a pattern that backtracks super-linearly blocks whatever thread it
 * is on for as long as it takes. Here that thread is this one, which answers
 * nothing else and can be ended from outside. The budget is kept by the caller,
 * because the only way to stop a running match is to end the thread running
 * it. */
interface Ask {
  readonly texts: readonly string[];
  /** How many matches the caller has room for. The rest would be read by
   * nobody, and finding them is the cost this is about. */
  readonly want: number;
}

const patterns = (workerData as { patterns: { source: string; flags: string }[] }).patterns;
const matchers = patterns.map((each) => new RegExp(each.source, each.flags));

parentPort?.on("message", (ask: Ask) => {
  const found: number[] = [];
  for (let at = 0; at < ask.texts.length && found.length < ask.want; at += 1) {
    const text = ask.texts[at] as string;
    if (matchers.some((matcher) => matcher.test(text))) found.push(at);
  }
  parentPort?.postMessage(found);
});
