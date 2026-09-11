import { describe, expect, test } from "bun:test";
import {
  type Capability,
  isRoleAllowed,
  OP_NAMES,
  opAttributes,
  type OpName,
  Role as RoleSchema,
  type Role,
} from "@ccmsg/protocol";
import { dispatch, type DispatchDeps } from "../src/dispatch/dispatch.ts";
import type { HandlerInput, Handlers } from "../src/dispatch/handler.ts";
import { OpError } from "../src/dispatch/result.ts";
import { connAs, frameFor, frameProblems, OTHER_INSTANCE, SELF, TestConn } from "./frames.ts";

/** The roles and capabilities the contract defines, read from the contract so
 * the sweeps below cover whatever it holds rather than a copy of it. */
const ROLES: Role[] = (RoleSchema.anyOf as { const: Role }[]).map((branch) => branch.const);
const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set(
  OP_NAMES.map((op) => opAttributes(op).capability).filter((cap) => cap !== undefined),
);

/** Handlers that record what they were given. One per op, because the record is
 * total: an op the table gains has to arrive here to compile. */
function recordingHandlers(): { handlers: Handlers; seen: HandlerInput[] } {
  const seen: HandlerInput[] = [];
  const entries = OP_NAMES.map((op) => [
    op,
    (input: HandlerInput) => {
      seen.push(input);
      return { handled: op };
    },
  ]);
  return { handlers: Object.fromEntries(entries) as Handlers, seen };
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    self: SELF,
    capabilities: ALL_CAPABILITIES,
    resolveInstance: () => undefined,
    handlers: recordingHandlers().handlers,
    ...over,
  };
}

const as = connAs;

/** A connection with no identity settled, for the steps that run before hello. */
function anonymous(): TestConn {
  return new TestConn();
}

/** A role the op allows, for sweeps that want to get past step 4. */
function allowedRole(op: OpName): Role {
  return opAttributes(op).roles[0] as Role;
}

function errorCode(result: Awaited<ReturnType<typeof dispatch>>): string | undefined {
  return result.kind === "error" ? result.response.error.code : undefined;
}

describe("the fixtures", () => {
  test("every op has arguments the contract accepts", () => {
    for (const op of OP_NAMES) expect([op, frameProblems(op)]).toEqual([op, []]);
  });
});

/** The ops the table says are reached over HTTP.
 *
 * They are in the table because the table is where authorization is decided,
 * but they never arrive as a frame: what they do — set or read a cookie — a
 * frame on an open connection cannot. So dispatch refuses them, and the sweeps
 * below ask that of them instead of asking them to answer. */
const OVER_HTTP = OP_NAMES.filter((op) => opAttributes(op).carrier === "http");

describe("an op the table carries over HTTP is not reachable as a frame", () => {
  test("dispatch refuses it whoever asks", async () => {
    expect(OVER_HTTP.length).toBeGreaterThan(0);
    for (const op of OVER_HTTP) {
      const result = await dispatch(frameFor(op), as(allowedRole(op)), deps());
      expect([op, errorCode(result)]).toEqual([op, "bad_request"]);
    }
  });
});

describe("every op in the table goes through dispatch (M1)", () => {
  test("each op reaches its handler and answers", async () => {
    for (const op of OP_NAMES.filter((op) => !OVER_HTTP.includes(op))) {
      const { handlers, seen } = recordingHandlers();
      const result = await dispatch(frameFor(op), as(allowedRole(op)), deps({ handlers }));
      expect([op, result.kind]).toEqual([op, "reply"]);
      expect(seen.map((input) => input.op)).toEqual([op]);
    }
  });

  test("the reply carries the correlation id and the handler's body", async () => {
    const result = await dispatch(frameFor("instance.ping"), as("user"), deps());
    expect(result).toEqual({
      kind: "reply",
      response: { ok: true, request_id: "1", handled: "instance.ping" },
    });
  });
});

describe("step 4: roles outside the table are refused (swept over the table)", () => {
  for (const op of OP_NAMES) {
    const outside = ROLES.filter((role) => !isRoleAllowed(op, role));
    for (const role of outside) {
      test(`${op} refuses ${role}`, async () => {
        const result = await dispatch(frameFor(op), as(role), deps());
        expect(errorCode(result)).toBe("forbidden");
      });
    }
  }
});

describe("each step answers on its own", () => {
  test("a frame that is not an object is bad_request", async () => {
    expect(errorCode(await dispatch("[]", anonymous(), deps()))).toBe("bad_request");
    expect(errorCode(await dispatch(null, anonymous(), deps()))).toBe("bad_request");
    expect(errorCode(await dispatch([], anonymous(), deps()))).toBe("bad_request");
  });

  test("a frame without an op or a request_id is bad_request", async () => {
    expect(errorCode(await dispatch({ request_id: "1" }, as("user"), deps()))).toBe("bad_request");
    const noId = await dispatch({ op: "instance.ping" }, as("user"), deps());
    expect(errorCode(noId)).toBe("bad_request");
    // Nothing to correlate the failure with, so the reply names no request.
    expect(noId.kind === "error" && noId.response.request_id).toBeUndefined();
  });

  test("step 1: an op outside the table is unknown_op", async () => {
    const result = await dispatch({ op: "no_such_op", request_id: "1" }, as("user"), deps());
    expect(errorCode(result)).toBe("unknown_op");
  });

  test("step 2: arguments outside the schema are invalid_args", async () => {
    const result = await dispatch(
      frameFor("message.send", { to: "not-a-sid" }),
      as("user"),
      deps(),
    );
    expect(errorCode(result)).toBe("invalid_args");
  });

  test("step 3: an op needing hello is refused before the identity is settled", async () => {
    const result = await dispatch(frameFor("session.search"), anonymous(), deps());
    expect(errorCode(result)).toBe("hello_required");
  });

  test("step 3: the two ops that run before hello are reached anonymously", async () => {
    for (const op of OP_NAMES.filter(
      (name) => !opAttributes(name).needs_hello && !OVER_HTTP.includes(name),
    )) {
      const result = await dispatch(frameFor(op), anonymous(), deps());
      expect([op, result.kind]).toEqual([op, "reply"]);
    }
  });

  test("step 4: a role outside the op's roles is forbidden", async () => {
    expect(errorCode(await dispatch(frameFor("session.kill"), as("session"), deps()))).toBe(
      "forbidden",
    );
  });

  test("step 5: a capability the instance lacks is capability_unavailable", async () => {
    const without = deps({ capabilities: new Set<Capability>() });
    const result = await dispatch(frameFor("session.rename"), as("user"), without);
    expect(errorCode(result)).toBe("capability_unavailable");
  });

  test("step 5: every op declaring a capability reports its absence", async () => {
    for (const op of OP_NAMES.filter((name) => opAttributes(name).capability !== undefined)) {
      const result = await dispatch(
        frameFor(op),
        as(allowedRole(op)),
        deps({ capabilities: new Set<Capability>() }),
      );
      expect([op, errorCode(result)]).toEqual([op, "capability_unavailable"]);
    }
  });

  test("step 6: an instance-local op owned elsewhere is forwarded, not answered", async () => {
    const elsewhere = deps({ resolveInstance: () => OTHER_INSTANCE });
    const result = await dispatch(frameFor("session.kill"), as("user"), elsewhere);
    expect(result).toEqual({
      kind: "forward",
      to: OTHER_INSTANCE,
      frame: frameFor("session.kill"),
    });
  });

  test("step 6: an instance-local op owned here is answered", async () => {
    const here = deps({ resolveInstance: () => SELF });
    const result = await dispatch(frameFor("session.kill"), as("user"), here);
    expect(result.kind).toBe("reply");
  });

  test("step 6: a request naming another instance is forwarded", async () => {
    const result = await dispatch(
      frameFor("session.kill", { to_instance: OTHER_INSTANCE }),
      as("user"),
      deps(),
    );
    expect(result.kind).toBe("forward");
  });

  test("step 7: an implementation that throws is internal_error, not the caller's fault", async () => {
    const { handlers } = recordingHandlers();
    const failing: Handlers = {
      ...handlers,
      "session.search": () => {
        throw new Error("the index is on fire");
      },
    };
    const result = await dispatch(
      frameFor("session.search"),
      as("user"),
      deps({ handlers: failing }),
    );
    expect(errorCode(result)).toBe("internal_error");
    // The message is the only thing that says more, so it carries the cause.
    expect(result.kind === "error" && result.response.error.msg).toContain("the index is on fire");
  });

  test("step 7: an OpError still answers in its own code", async () => {
    const { handlers } = recordingHandlers();
    const failing: Handlers = {
      ...handlers,
      "session.search": () => {
        throw new OpError("not_found", "no such record");
      },
    };
    const result = await dispatch(
      frameFor("session.search"),
      as("user"),
      deps({ handlers: failing }),
    );
    expect(errorCode(result)).toBe("not_found");
  });

  test("step 6: cluster ops are answered wherever they arrive", async () => {
    const elsewhere = deps({ resolveInstance: () => OTHER_INSTANCE });
    for (const op of OP_NAMES.filter(
      (name) => opAttributes(name).locality === "cluster" && !OVER_HTTP.includes(name),
    )) {
      const result = await dispatch(frameFor(op), as(allowedRole(op)), elsewhere);
      expect([op, result.kind]).toEqual([op, "reply"]);
    }
  });
});

describe("the role reaches an implementation only through scope", () => {
  test("scope: role ops receive the role, and no others do", async () => {
    for (const op of OP_NAMES) {
      const { handlers, seen } = recordingHandlers();
      const role = allowedRole(op);
      await dispatch(frameFor(op), as(role), deps({ handlers }));
      const expected = opAttributes(op).scope === "role" ? role : undefined;
      expect([op, seen[0]?.role]).toEqual([op, expected]);
    }
  });

  test("the ops with a scope are the ones the contract marks", () => {
    const scoped = OP_NAMES.filter((op) => opAttributes(op).scope === "role");
    expect(scoped).toEqual(["transcript.read", "transcript.items.read", "dir.list", "file.read"]);
  });
});
