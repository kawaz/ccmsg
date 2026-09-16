import { createHash } from "node:crypto";
import {
  type AuthAssertArgs,
  type AuthTokenRefreshArgs,
  type AuthRegisterArgs,
  type ErrorCode,
  type InstanceId,
  OP_SCHEMAS,
  type OpName,
  validationErrors,
} from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import type { Auth, MintedSession } from "./auth.ts";

/** The four ops the contract carries over HTTP, and the path each is at.
 *
 * They are `needs_hello: false` ops like `hello` is, run before there is an
 * identity to check, and the carrier is what makes them reachable from a page
 * that has no connection yet — a `request_id` is synthesized here because
 * there is no envelope to carry one (DR-0001 §2.9). */
const ROUTES = ["challenge", "register", "assert", "refresh"] as const;
type Route = (typeof ROUTES)[number];

/** Which op each route carries. The route is a name a proxy can see; the op is
 * what the attribute table and the schemas are keyed by. */
const OP_OF: Record<Route, OpName> = {
  challenge: "auth.challenge",
  register: "auth.register",
  assert: "auth.assert",
  refresh: "auth.token.refresh",
};

/** Cap on an `/auth/*` body. Everything these take is a handful of base64url
 * fields; an attestation object is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Which of the routes a path is, matched at the end rather than whole.
 *
 * The prefix is not read, for the reason the WebSocket's own entry is not:
 * a proxy may put the instance under a prefix of its own, and which instance
 * was meant is settled by the address it forwarded to (DR-0001 §2.7). */
export function authRouteOf(pathname: string): Route | undefined {
  const marker = "/auth/";
  const at = pathname.lastIndexOf(marker);
  if (at === -1) return undefined;
  const name = pathname.slice(at + marker.length);
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : undefined;
}

/** The endpoint path a request arrived under: everything before its `auth/`.
 *
 * What a credential's endpoint is compared against, so that `https://h/` and
 * `https://h/personal/` are two instances rather than two spellings of one
 * (contract, `CredentialRecord.endpoint`). */
export function endpointPath(pathname: string): string {
  const at = pathname.lastIndexOf("/auth/");
  return at === -1 ? "/" : pathname.slice(0, at + 1);
}

/** The cookie path for a request: everything up to and including its `/auth/`.
 *
 * It narrows what the browser sends where, and nothing more — same-origin
 * script can fetch any path, so this is not an authorization boundary (DR-0001 §2.4).
 * What it is for is that two endpoints behind one origin (`/` and `/personal`)
 * get cookies of their own. */
export function cookiePath(pathname: string): string {
  const at = pathname.lastIndexOf("/auth/");
  return at === -1 ? "/" : pathname.slice(0, at + "/auth/".length);
}

/** What a person's refresh cookie is called on this instance.
 *
 * Named after the instance and the subject so that two instances behind one
 * origin, and two people at one browser, do not overwrite each other's. The
 * digest is what keeps the id and the subject out of a header a page can
 * read. */
export function cookieName(instance: InstanceId, sub: string): string {
  const digest = createHash("sha256").update(`${instance}\n${sub}`).digest("hex").slice(0, 16);
  return `__Secure-ccmsg-${digest}`;
}

/** The value of one cookie in a request, or nothing. */
export function cookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return part.slice(at + 1).trim();
  }
  return undefined;
}

export interface AuthRoutesDeps {
  readonly auth: Auth;
  readonly self: InstanceId;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Serve `<endpoint>auth/*`, or answer nothing when the request is for
 * something else.
 *
 * Everything unauthenticated shares one rate limit and one origin check: these
 * routes are reachable before anything is proven, and the work behind them is a
 * signature verification (DR-0001 §2.4). */
export async function handleAuth(
  request: Request,
  deps: AuthRoutesDeps,
  from: { ip?: string } = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = authRouteOf(url.pathname);
  if (route === undefined) return undefined;
  const origin = request.headers.get("origin");
  // A page from an origin this instance is not one of is refused before
  // anything else, including the preflight that would tell it to try. Compared
  // whole rather than by domain: `/auth/refresh` answers with a person's access
  // token, and a browser attaches the cookie it is asked for by domain, so a
  // sibling subdomain let in here could read that token (DR-0001 §2.3).
  if (origin !== null && !deps.auth.knownOrigins().includes(origin)) {
    return new Response("Forbidden", { status: 403 });
  }
  // The three ops that decide an identity are held to two headers a page's own
  // script cannot write: an `Origin`, which is compared with the web UI the
  // claims or the record name, and a `Sec-Fetch-Site` that is anything but
  // `none`. Either one absent is a mismatch and not an exemption — every gate
  // has to be passed, and a caller with nothing to compare has not passed it
  // (contract, DR-0029 / DR-0028).
  //
  // `auth.challenge` is not among them: it is asked before there is anything to
  // compare a caller with, and what it hands out can only be spent by its
  // issuer against one of the three. It answers the CORS set like the rest.
  if (route !== "challenge" && request.method !== "OPTIONS") {
    if (origin === null) return new Response("Forbidden", { status: 403 });
    const site = request.headers.get("sec-fetch-site");
    if (site === null || site === "none") return new Response("Forbidden", { status: 403 });
  }
  const cors: Record<string, string> =
    origin === null
      ? {}
      : {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          vary: "Origin",
        };
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      },
    });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  }
  if (!deps.auth.allowRequest()) {
    return new Response("too many requests", { status: 429, headers: cors });
  }

  let args: Record<string, unknown>;
  try {
    args = await body(request);
  } catch (cause) {
    return refusal("bad_request", String(cause), cors);
  }
  // The op's own schema, run before anything reads a field. The carrier
  // synthesizes the envelope the contract asks for — there is no connection to
  // carry one — so what is validated is the same frame dispatch would have
  // validated, and a body missing a field is a refusal rather than a fault
  // inside a handler.
  const op = OP_OF[route];
  // The body first, so a caller cannot name the op or the correlation id by
  // putting either in it: what the carrier decided is what stands.
  const frame = { ...args, op, request_id: `http-${crypto.randomUUID()}` };
  const problems = validationErrors(OP_SCHEMAS[op].request, frame);
  if (problems.length > 0) return refusal("invalid_args", problems.join("; "), cors);

  const userAgent = request.headers.get("user-agent") ?? undefined;
  const seen = {
    ...(from.ip === undefined ? {} : { ip: from.ip }),
    ...(userAgent === undefined ? {} : { userAgent }),
    // Where the request actually arrived, which is what an endpoint's path is
    // compared against. Observed here rather than taken from the body: a caller
    // stating which instance it reached would be stating the answer.
    path: endpointPath(url.pathname),
    // The browser's own word for where the page was served from, which the op
    // holds to the web UI its claims or its record name. `null` is a request
    // that carried none, which is a mismatch rather than an absent check.
    origin,
  };
  try {
    switch (route) {
      case "challenge":
        return answer(deps.auth.challenge(), cors);
      case "register": {
        const minted = await deps.auth.register(args as unknown as AuthRegisterArgs, seen);
        return answer(minted.session, cors, setCookie(deps, url, minted));
      }
      case "assert": {
        const minted = await deps.auth.assert(args as unknown as AuthAssertArgs, seen);
        return answer(minted.session, cors, setCookie(deps, url, minted));
      }
      case "refresh": {
        const held = refreshCookie(request, deps);
        if (held === undefined) {
          return refusal("auth_invalid", "この要求には refresh token がありません", cors);
        }
        const { reason } = args as unknown as AuthTokenRefreshArgs;
        const minted = await deps.auth.refreshToken(held, {
          ...(reason === undefined ? {} : { reason }),
          ...(seen.ip === undefined ? {} : { ip: seen.ip }),
          ...(seen.userAgent === undefined ? {} : { userAgent: seen.userAgent }),
          origin: seen.origin,
        });
        return answer(minted.session, cors, setCookie(deps, url, minted));
      }
    }
  } catch (cause) {
    if (cause instanceof OpError) return refusal(cause.code, cause.message, cors);
    deps.log?.("an auth route failed", { route, error: String(cause) });
    return refusal("internal_error", "この要求は処理できませんでした", cors);
  }
}

/** The refresh token this request carries.
 *
 * Every cookie whose name has this instance's prefix is tried, because the name
 * carries a digest of the subject and the caller has not said who they are yet.
 * A browser holding two people's cookies presents both. */
function refreshCookie(request: Request, deps: AuthRoutesDeps): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    const name = part.slice(0, at).trim();
    if (!name.startsWith("__Secure-ccmsg-")) continue;
    const value = part.slice(at + 1).trim();
    if (deps.auth.records.byRefresh(value) !== undefined) return value;
  }
  // None of them is a standing token. The first one is answered with anyway, so
  // that a value rotated away is seen as the reuse it is rather than as an
  // absent cookie.
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim().startsWith("__Secure-ccmsg-")) {
      return part.slice(at + 1).trim();
    }
  }
  return undefined;
}

/** The `Set-Cookie` for what the op just minted.
 *
 * The refresh token is answered by the op to its caller rather than left in a
 * slot on the domain, so two exchanges in flight cannot hand one caller the
 * other's token. */
function setCookie(deps: AuthRoutesDeps, url: URL, minted: MintedSession): Record<string, string> {
  const name = cookieName(deps.self, minted.session.sub);
  const maxAge = Math.max(0, Math.floor((minted.refresh.expires_at - Date.now()) / 1000));
  // Where this endpoint is published, which is the site the cookie belongs to.
  // The configured address rather than the one observed: a proxy in front of
  // this instance is what a browser actually reached, and the endpoint is what
  // that address is (DESIGN §7.1). An instance the mesh names none for is
  // reached at the address it was asked at.
  const endpoint = deps.auth.endpoint() ?? url.origin;
  return {
    "set-cookie": [
      `${name}=${minted.refresh.value}`,
      "HttpOnly",
      "Secure",
      ...(sameSite(minted.webui, endpoint)
        ? ["SameSite=Strict"]
        : // A page at another site: the browser sends this only as a cookie
          // partitioned by the top-level site it was set under, which is what
          // keeps a session taken at one site from being carried to another.
          // A browser that does not partition is not an environment this is
          // spoken over, so there is no second spelling for one (DR-0028).
          ["SameSite=None", "Partitioned"]),
      `Path=${cookiePath(url.pathname)}`,
      `Max-Age=${String(maxAge)}`,
    ].join("; "),
  };
}

/** Whether the page and this endpoint are one site, which is what decides
 * whether the refresh cookie ever crosses one (DR-0028).
 *
 * A site is a scheme and a registrable domain, and the registrable part of a
 * host is only knowable from the public suffix list — which this instance does
 * not carry, and which would be a table to keep current for a value read on
 * every exchange. Hosts are compared whole instead: equal hosts are one site
 * under any suffix list, and anything else is treated as another one.
 *
 * Design rationale: the approximation errs one way only. Two hosts under one
 * registrable domain (`ui.example.net` and `mba.example.net`) are one site and
 * are read here as two, so their cookie is partitioned where it need not have
 * been — which a browser still sends, the partition being that same site. The
 * opposite mistake, reading two sites as one and setting a cookie that crosses
 * between them unpartitioned, cannot be made. */
function sameSite(webui: string, endpoint: string): boolean {
  const page = new URL(webui);
  const here = new URL(endpoint);
  return page.protocol === here.protocol && page.hostname === here.hostname;
}

function answer(
  result: unknown,
  cors: Record<string, string>,
  extra: Record<string, string> = {},
): Response {
  return Response.json(result, { headers: { ...cors, ...extra } });
}

/** A refusal in the contract's own error shape, so a page reads one thing
 * whether the op travelled over HTTP or over the WebSocket. */
function refusal(code: ErrorCode | "bad_request", msg: string, cors: Record<string, string>) {
  // A malformed request is the caller's to fix and an authentication failure is
  // not, so the two do not share a status: 401 says "these credentials were not
  // accepted", which is the wrong thing to tell somebody who left a field out.
  const status =
    code === "bad_request" || code === "invalid_args" ? 400 : code === "internal_error" ? 500 : 401;
  return Response.json({ ok: false, error: { code, msg } }, { status, headers: cors });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error(`the body is over ${String(MAX_BODY_BYTES)} bytes`);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error(`the body is over ${String(MAX_BODY_BYTES)} bytes`);
  }
  if (text === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the body is a JSON object");
  }
  return parsed as Record<string, unknown>;
}
