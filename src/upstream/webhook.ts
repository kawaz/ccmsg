import { timingSafeEqual } from "node:crypto";

/** Cap on one posted body. The gateway splits its own deliveries at a
 * megabyte, so a body past this is not one of its batches. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** What a path segment naming a producer may be. Narrow on purpose: the
 * segment picks a configured source, so it must not be able to express
 * traversal or a case that matches two ways. */
export const SOURCE_NAME = /^[a-z0-9-]{1,64}$/;

/** The producer a path names, matched at the end of the path.
 *
 * A gateway posts to whatever URL its operator gave it, which may sit under a
 * proxy's prefix, so the segment before `/webhook/` is not read (DR-0001 §2.7).
 * Which instance is meant was settled by the address the proxy forwarded to;
 * what still has to be right is the source name and the token it presents.
 *
 * The last `/webhook/` wins, so a source cannot be smuggled in through a
 * prefix that contains the marker itself. */
export function sourceOfPath(pathname: string): string | undefined {
  const marker = "/webhook/";
  const at = pathname.lastIndexOf(marker);
  return at === -1 ? undefined : pathname.slice(at + marker.length);
}

export interface WebhookSource {
  /** The path segment this producer posts to, after `/webhook/`. */
  readonly name: string;
  /** The secret it presents as `Authorization: Bearer`. The gateway reads the
   * same value out of its own token file (DR-0012); this is the only thing
   * standing between the route and anyone the entry check let through. */
  readonly token: string;
  /** Take one posted batch. The items are raw: reading them is the source's
   * own business, and one it cannot read must not fail the delivery. */
  handle(items: readonly unknown[]): void;
}

/** Serve `POST /webhook/<source>`, or answer nothing when the request is for
 * something else — the caller then goes on to its other routes.
 *
 * Fire and forget by design. The gateway sends one way, does not retry and
 * does not reorder, so an item this instance cannot use is worth a log line
 * and nothing more: answering 4xx over one bad item would only teach a
 * producer to repeat it. The body being unreadable as a whole is the one
 * failure its sender can act on, so it is the one it hears about. */
export async function handleWebhook(
  request: Request,
  source: WebhookSource | undefined,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<Response | undefined> {
  const name = sourceOfPath(new URL(request.url).pathname);
  if (name === undefined) return undefined;
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  // An unconfigured source does not exist as far as a caller can tell, which
  // is also what keeps the answer from naming what could be turned on.
  if (source === undefined || !SOURCE_NAME.test(name) || name !== source.name) {
    return new Response("Not Found", { status: 404 });
  }
  if (!authorized(request.headers.get("authorization"), source.token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();

  let text: string;
  try {
    text = await bounded(request);
  } catch (cause) {
    if (cause instanceof TooLarge) return tooLarge();
    return new Response(`the body could not be read: ${String(cause)}`, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    log?.("a webhook delivery was not JSON", { source: source.name, error: String(cause) });
    return new Response("the body is not JSON", { status: 400 });
  }
  try {
    // The gateway always posts an array; one bare item is the same thing to
    // whoever reads them.
    source.handle(Array.isArray(parsed) ? parsed : [parsed]);
  } catch (cause) {
    // A reader that throws is this instance's own fault, not the sender's: it
    // is logged and the delivery is still accepted.
    log?.("a webhook reader failed", { source: source.name, error: String(cause) });
  }
  return new Response(null, { status: 204 });
}

/** Whether the request presents exactly this source's token.
 *
 * Compared in constant time. The route is reachable only by whoever the entry
 * check of DESIGN §2.1 already let through, but a comparison that leaks its prefix
 * through timing is the kind of thing that quietly stops being enough once an
 * instance is bound past loopback. */
function authorized(header: string | null, token: string): boolean {
  if (header === null) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  // A length mismatch cannot go through `timingSafeEqual`, and the length is
  // not the secret.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

class TooLarge extends Error {}

function tooLarge(): Response {
  return new Response(`the body is over ${MAX_BODY_BYTES} bytes`, { status: 413 });
}

/** Read the body with a hard ceiling. `request.json()` would buffer the whole
 * stream before any limit could apply, and the declared length is advisory —
 * absent entirely under chunked encoding. This route shares an event loop with
 * every connected client. */
async function bounded(request: Request): Promise<string> {
  const body = request.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new TooLarge();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}
