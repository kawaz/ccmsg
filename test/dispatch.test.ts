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
import { ANONYMOUS, type ConnIdentity } from "../src/dispatch/identity.ts";
import { frameFor, frameProblems, OTHER_INSTANCE, SELF, SID } from "./frames.ts";

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

function as(role: Role): ConnIdentity {
  return { state: "settled", role, sid: SID };
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

describe("every op in the table goes through dispatch (M1)", () => {
  test("each op reaches its handler and answers", async () => {
    for (const op of OP_NAMES) {
      const { handlers, seen } = recordingHandlers();
      const result = await dispatch(frameFor(op), as(allowedRole(op)), deps({ handlers }));
      expect([op, result.kind]).toEqual([op, "reply"]);
      expect(seen.map((input) => input.op)).toEqual([op]);
    }
  });

  test("the reply carries the correlation id and the handler's body", async () => {
    const result = await dispatch(frameFor("instance_ping"), as("user"), deps());
    expect(result).toEqual({
      kind: "reply",
      response: { ok: true, request_id: "1", handled: "instance_ping" },
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
    expect(errorCode(await dispatch("[]", ANONYMOUS, deps()))).toBe("bad_request");
    expect(errorCode(await dispatch(null, ANONYMOUS, deps()))).toBe("bad_request");
    expect(errorCode(await dispatch([], ANONYMOUS, deps()))).toBe("bad_request");
  });

  test("a frame without an op or a request_id is bad_request", async () => {
    expect(errorCode(await dispatch({ request_id: "1" }, as("user"), deps()))).toBe("bad_request");
    const noId = await dispatch({ op: "instance_ping" }, as("user"), deps());
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
      frameFor("message_send", { to: "not-a-sid" }),
      as("user"),
      deps(),
    );
    expect(errorCode(result)).toBe("invalid_args");
  });

  test("step 3: an op needing hello is refused before the identity is settled", async () => {
    const result = await dispatch(frameFor("session_search"), ANONYMOUS, deps());
    expect(errorCode(result)).toBe("hello_required");
  });

  test("step 3: the two ops that run before hello are reached anonymously", async () => {
    for (const op of OP_NAMES.filter((name) => !opAttributes(name).needs_hello)) {
      const result = await dispatch(frameFor(op), ANONYMOUS, deps());
      expect([op, result.kind]).toEqual([op, "reply"]);
    }
  });

  test("step 4: a role outside the op's roles is forbidden", async () => {
    expect(errorCode(await dispatch(frameFor("session_kill"), as("session"), deps()))).toBe(
      "forbidden",
    );
  });

  test("step 5: a capability the instance lacks is capability_unavailable", async () => {
    const without = deps({ capabilities: new Set<Capability>() });
    const result = await dispatch(frameFor("session_rename"), as("user"), without);
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
    const result = await dispatch(frameFor("session_kill"), as("user"), elsewhere);
    expect(result).toEqual({
      kind: "forward",
      to: OTHER_INSTANCE,
      frame: frameFor("session_kill"),
    });
  });

  test("step 6: an instance-local op owned here is answered", async () => {
    const here = deps({ resolveInstance: () => SELF });
    const result = await dispatch(frameFor("session_kill"), as("user"), here);
    expect(result.kind).toBe("reply");
  });

  test("step 6: a request naming another instance is forwarded", async () => {
    const result = await dispatch(
      frameFor("session_kill", { to_instance: OTHER_INSTANCE }),
      as("user"),
      deps(),
    );
    expect(result.kind).toBe("forward");
  });

  test("step 6: cluster ops are answered wherever they arrive", async () => {
    const elsewhere = deps({ resolveInstance: () => OTHER_INSTANCE });
    for (const op of OP_NAMES.filter((name) => opAttributes(name).locality === "cluster")) {
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
    expect(scoped).toEqual(["transcript_read", "dir_list", "file_read"]);
  });
});
