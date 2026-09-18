import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import {
  type AuthAssertArgs,
  type AuthEnrollArgs,
  type AuthTokenRefreshArgs,
  type AuthRegisterArgs,
  type ErrorCode,
  type InstanceId,
  OP_SCHEMAS,
  type OpName,
  type UserId,
  validationErrors,
} from "@ccmsg/protocol";
import { OpError } from "../dispatch/index.ts";
import type { Auth, MintedSession } from "./auth.ts";

/** The five ops the contract carries over HTTP, and the path each is at.
 *
 * They are `needs_hello: false` ops like `hello` is, run before there is an
 * identity to check, and the carrier is what makes them reachable from a page
 * that has no connection yet — a `request_id` is synthesized here because
 * there is no envelope to carry one (DR-0001 §2.9). */
const ROUTES = ["challenge", "register", "enroll", "assert", "refresh"] as const;
type Route = (typeof ROUTES)[number];

/** Which op each route carries. The route is a name a proxy can see; the op is
 * what the attribute table and the schemas are keyed by. */
const OP_OF: Record<Route, OpName> = {
  challenge: "auth.challenge",
  register: "auth.register",
  enroll: "auth.enroll",
  assert: "auth.assert",
  refresh: "auth.token.refresh",
};

/** The routes an enrolment URL is spent on, which every origin may reach.
 *
 * Behind a load balancer the page's first POST lands wherever the balancer
 * sends it, and the instance it lands on has never heard of the origin the URL
 * names — there is no credential for it yet. What guards an enrolment is the
 * token, the six digits and the issuer's count of tries against them; CORS
 * guards nothing here, and a list it could be checked against would only make
 * the enrolment fail on whichever instance was reached (contract, DR-0030 §9).
 *
 * `challenge` is among them because the page has to ask for one before it can
 * begin, and what it hands out can only be spent by its issuer against one of
 * the checked ops. */
const OPEN_TO_EVERY_ORIGIN: readonly Route[] = ["challenge", "register", "enroll"];

/** What a `Sec-Fetch-Site` may say for one of these to be a page's request.
 *
 * The three relations a fetch made by a page has to the site it is going to
 * (Fetch Metadata). The fourth value the specification defines, `none`, is a
 * request with no initiator — what a person typing an address produces, and
 * what a user-initiated operation does — which is not how any of these ops is
 * reached. Named as the set that passes rather than as the one value that does
 * not, so a value outside the specification is refused rather than admitted by
 * having no rule against it.
 *
 * It is a gate and not a proof of a browser: what it shows is that a caller
 * writing the header wrote one of the values a browser would (contract,
 * DR-0028). */
const FETCH_SITES = ["same-origin", "same-site", "cross-site"];

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
 * script can fetch any path, so this is not an authorization boundary (DR-0001 §2.4).
 * What it is for is that two endpoints behind one origin (`/` and `/personal`)
 * get cookies of their own. */
export function cookiePath(pathname: string): string {
  const at = pathname.lastIndexOf("/auth/");
  return at === -1 ? "/" : pathname.slice(0, at + "/auth/".length);
}

/** What a person's refresh cookie is called.
 *
 * Named after the person and nobody else. An instance in the name would mean
 * that a cookie set by one instance behind a load balancer is not recognised as
 * its own by the next one the browser reaches — the family is replicated and
 * every owned instance may rotate it, so the name has to be the same wherever
 * that happens (contract, DR-0030 §5). Two people at one browser still get one
 * cookie each, which is what the name has to tell apart.
 *
 * The digest is what keeps the person's id out of a header a page can read. */
export function cookieName(user: UserId): string {
  const digest = createHash("sha256").update(user).digest("hex").slice(0, 16);
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
  // A page at an origin none of this instance's owners made a passkey at is
  // refused before anything else, including the preflight that would tell it to
  // try. Compared whole rather than by domain: the refresh route answers with a
  // person's access token, and a browser attaches the cookie it is asked for by
  // domain, so a sibling subdomain let in here could read that token. The
  // enrolment routes are open to every origin instead, for the reason
  // `OPEN_TO_EVERY_ORIGIN` gives.
  if (
    origin !== null &&
    !OPEN_TO_EVERY_ORIGIN.includes(route) &&
    !deps.auth.knownOrigins().includes(origin)
  ) {
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
  // The four ops that decide an identity are held to two headers a page's own
  // script cannot write: an `Origin`, which the op compares with the origin the
  // claims or the record name, and a `Sec-Fetch-Site` naming one of the three
  // relations a request made by a page can have to the site it went to. Either
  // one absent is a mismatch and not an exemption — every gate has to be
  // passed, and a caller with nothing to compare has not passed it. The answer
  // is the one every binding gives, saying that the exchange was refused and
  // not which gate refused it; which one is written to the log, where the
  // operator rather than the caller reads it (contract, DR-0029 / DR-0028).
  //
  // `auth.challenge` is not among them: it is asked before there is anything to
  // compare a caller with, and what it hands out can only be spent by its
  // issuer against one of the three. It answers the CORS set like the rest.
  if (route !== "challenge" && request.method !== "OPTIONS") {
    const site = request.headers.get("sec-fetch-site");
    const gate =
      origin === null ? "Origin" : !FETCH_SITES.includes(site ?? "") ? "Sec-Fetch-Site" : undefined;
    if (gate !== undefined) {
      deps.log?.("an auth request states no page it came from", { route, header: gate, site });
      return refusal("auth_invalid", "この要求は受け付けられません", cors);
    }
  }
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
    // The browser's own word for where the page was served from, which the op
    // holds to the origin its claims or its record name. `null` is a request
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
      case "enroll": {
        const minted = await deps.auth.enroll(args as unknown as AuthEnrollArgs, seen);
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
  const name = cookieName(minted.session.user);
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
      ...(sameSite(minted.origin, endpoint)
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
 * A site is a scheme and a registrable domain, and which part of a host is
 * registrable is only knowable from the public suffix list — the same list the
 * browser deciding whether to send this cookie reads, so this instance reads it
 * too rather than approximating it. The list's private section is included,
 * because a browser includes it: `a.github.io` and `b.github.io` are two sites
 * to one, and a cookie set as though they were one would simply not be sent.
 *
 * A host with no registrable domain — an address literal, `localhost`, a name
 * under no public suffix — falls back to the host itself, which is the finest
 * thing that can be said about it and the safe one: two such hosts are two
 * sites unless they are the same host. */
function sameSite(origin: string, endpoint: string): boolean {
  const page = new URL(origin);
  const here = new URL(endpoint);
  if (page.protocol !== here.protocol) return false;
  return siteOf(page.hostname) === siteOf(here.hostname);
}

function siteOf(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
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
