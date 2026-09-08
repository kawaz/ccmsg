import { describe, expect, test } from "bun:test";
import { OP_SCHEMAS, type TranslateRunResult, validationErrors } from "@ccmsg/protocol";
import { OpError } from "../src/dispatch/index.ts";
import { type HelperChannel, Translate } from "../src/translate/index.ts";

/** A helper that answers the line protocol, without a program on the host.
 *
 * `answer` is given what the batch said and returns the line to write back, or
 * `undefined` to say nothing — which is what a helper that died looks like from
 * this side. */
function helper(answer: (batch: { id: string; texts: string[] }) => string | undefined) {
  const written: string[] = [];
  let killed = 0;
  let pending: string | undefined;
  const channel: HelperChannel = {
    write: (line) => {
      written.push(line);
      pending = answer(JSON.parse(line) as { id: string; texts: string[] });
      return Promise.resolve();
    },
    read: () => {
      const line = pending;
      pending = undefined;
      return Promise.resolve(line);
    },
    kill: () => {
      killed += 1;
    },
  };
  return { channel, written, kills: () => killed };
}

/** One batch translated, held to the op's own response schema (§11.1). */
async function translated(translate: Translate, texts: string[]): Promise<TranslateRunResult> {
  const body = await translate.run({ texts });
  expect(
    validationErrors(OP_SCHEMAS["translate_run"].response, {
      ok: true,
      request_id: "1",
      ...body,
    }),
  ).toEqual([]);
  return body;
}

async function refusalOf(call: () => Promise<unknown>): Promise<OpError> {
  try {
    await call();
  } catch (cause) {
    if (cause instanceof OpError) return cause;
    throw cause;
  }
  throw new Error("the call was not refused");
}

describe("a batch translated on this host", () => {
  test("one result per text, in the order they were sent", async () => {
    const answering = helper(({ id, texts }) =>
      JSON.stringify({
        id,
        results: texts.map((text) => ({ ok: true, text: text.toUpperCase() })),
      }),
    );
    const translate = new Translate("/nowhere", { start: () => answering.channel });
    const answer = await translated(translate, ["one", "two"]);
    expect(answer.results).toEqual([
      { ok: true, text: "ONE" },
      { ok: true, text: "TWO" },
    ]);
  });

  test("a text that failed fails alone, and the batch still succeeds", async () => {
    const answering = helper(({ id }) =>
      JSON.stringify({
        id,
        results: [
          { ok: false, error: "the language is not installed" },
          { ok: true, text: "ふたつめ" },
        ],
      }),
    );
    const translate = new Translate("/nowhere", { start: () => answering.channel });
    const answer = await translated(translate, ["one", "two"]);
    expect(answer.results).toEqual([
      { ok: false, error: "the language is not installed" },
      { ok: true, text: "ふたつめ" },
    ]);
  });

  test("an empty batch is answered without a helper being started", async () => {
    let started = 0;
    const translate = new Translate("/nowhere", {
      start: () => {
        started += 1;
        return helper(() => undefined).channel;
      },
    });
    expect(await translated(translate, [])).toEqual({ results: [] });
    expect(started).toBe(0);
  });

  test("the helper is started once and kept for the next batch", async () => {
    let started = 0;
    const answering = helper(({ id, texts }) =>
      JSON.stringify({ id, results: texts.map(() => ({ ok: true, text: "x" })) }),
    );
    const translate = new Translate("/nowhere", {
      start: () => {
        started += 1;
        return answering.channel;
      },
    });
    await translated(translate, ["one"]);
    await translated(translate, ["two"]);
    expect(started).toBe(1);
    // Each batch names itself, so two answers cannot be told apart by luck.
    expect(answering.written.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual([
      "1",
      "2",
    ]);
  });
});

describe("a helper that fails is the op's failure (translate_helper_failed)", () => {
  test("an answer to another batch is not this batch's", async () => {
    const answering = helper(() =>
      JSON.stringify({ id: "other", results: [{ ok: true, text: "" }] }),
    );
    const translate = new Translate("/nowhere", { start: () => answering.channel });
    expect((await refusalOf(() => translate.run({ texts: ["one"] }))).code).toBe(
      "translate_helper_failed",
    );
  });

  test("an answer of the wrong length would hand back texts nobody sent", async () => {
    const answering = helper(({ id }) => JSON.stringify({ id, results: [] }));
    const translate = new Translate("/nowhere", { start: () => answering.channel });
    expect((await refusalOf(() => translate.run({ texts: ["one", "two"] }))).code).toBe(
      "translate_helper_failed",
    );
  });

  test("a helper that stopped before answering, and the fresh one after it", async () => {
    let started = 0;
    const dead = helper(() => undefined);
    const alive = helper(({ id, texts }) =>
      JSON.stringify({ id, results: texts.map(() => ({ ok: true, text: "ok" })) }),
    );
    const translate = new Translate("/nowhere", {
      start: () => {
        started += 1;
        return started === 1 ? dead.channel : alive.channel;
      },
    });
    expect((await refusalOf(() => translate.run({ texts: ["one"] }))).code).toBe(
      "translate_helper_failed",
    );
    expect(dead.kills()).toBe(1);
    // The next call starts a new helper rather than talking to the dead one.
    expect((await translated(translate, ["one"])).results).toEqual([{ ok: true, text: "ok" }]);
    expect(started).toBe(2);
  });

  test("a batch that outlives its deadline ends the helper and gives up", async () => {
    const silent: HelperChannel & { kills: number } = {
      kills: 0,
      write: () => Promise.resolve(),
      // Never answers, and never says it stopped: the wedged case the deadline
      // is the only way out of.
      read: () => new Promise<string | undefined>(() => undefined),
      kill() {
        this.kills += 1;
      },
    };
    const translate = new Translate("/nowhere", {
      start: () => silent,
      deadlineMs: () => 5,
    });
    expect((await refusalOf(() => translate.run({ texts: ["one"] }))).code).toBe(
      "translate_helper_failed",
    );
    expect(silent.kills).toBe(1);
  });
});
