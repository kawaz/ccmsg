import { createHash } from "node:crypto";
import type { AuthAssertArgs, AuthRegisterArgs, ErrorCode, InstanceId } from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import type { Auth } from "./auth.ts";

/** The four ops the contract carries over HTTP, and the path each is at.
 *
 * They are `needs_hello: false` ops like `hello` is, run before there is an
 * identity to check, and the carrier is what makes them reachable from a page
 * that has no connection yet — a `request_id` is synthesized here because
 * there is no envelope to carry one (DR-0001 §2.9). */
const ROUTES = ["challenge", "register", "assert", "refresh"] as const;
type Route = (typeof ROUTES)[number];

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

/** The cookie path for a request: everything up to and including its `/auth/`.
 *
 * It narrows what the browser sends where, and nothing more — same-origin
 * script can fetch any path, so this is not an authorization boundary (§2.4).
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
  readonly origins: () => readonly string[];
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Serve `/auth/*`, or answer nothing when the request is for something else.
 *
 * Everything unauthenticated shares one rate limit and one origin check: these
 * routes are reachable before anything is proven, and the work behind them is a
 * signature verification (§2.4). */
export async function handleAuth(
  request: Request,
  deps: AuthRoutesDeps,
  from: { ip?: string } = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = authRouteOf(url.pathname);
  if (route === undefined) return undefined;
  const origin = request.headers.get("origin");
  const allowed = deps.origins();
  // A page from an origin this instance does not serve is refused before
  // anything else, including the preflight that would tell it to try.
  if (origin !== null && !allowed.includes(origin)) {
    return new Response("Forbidden", { status: 403 });
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

  const userAgent = request.headers.get("user-agent") ?? undefined;
  const seen = {
    ...(from.ip === undefined ? {} : { ip: from.ip }),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
  try {
    switch (route) {
      case "challenge":
        return answer(deps.auth.challenge(), cors);
      case "register": {
        const session = await deps.auth.register(args as unknown as AuthRegisterArgs, seen);
        return answer(session, cors, setCookie(deps, url.pathname));
      }
      case "assert": {
        const session = await deps.auth.assert(args as unknown as AuthAssertArgs, seen);
        return answer(session, cors, setCookie(deps, url.pathname));
      }
      case "refresh": {
        const held = refreshCookie(request, deps);
        if (held === undefined) {
          return refusal("auth_invalid", "この要求には refresh token がありません", cors);
        }
        const session = await deps.auth.refreshToken(held);
        return answer(session, cors, setCookie(deps, url.pathname));
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

/** The `Set-Cookie` for whatever the op just minted, or nothing when it minted
 * no refresh token. */
function setCookie(deps: AuthRoutesDeps, pathname: string): Record<string, string> {
  const minted = deps.auth.takeRefresh();
  if (minted === undefined) return {};
  const name = cookieName(deps.self, minted.sub);
  const maxAge = Math.max(0, Math.floor((minted.refresh.expires_at - Date.now()) / 1000));
  return {
    "set-cookie": [
      `${name}=${minted.refresh.value}`,
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      `Path=${cookiePath(pathname)}`,
      `Max-Age=${String(maxAge)}`,
    ].join("; "),
  };
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
  const status = code === "bad_request" ? 400 : code === "internal_error" ? 500 : 401;
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
