import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type {
  Capability,
  SandboxGrantArgs,
  SandboxGrantResult,
  SandboxRevokeArgs,
  SandboxRevokeResult,
  Sid,
  Timestamp,
} from "@ccmsg/protocol";
import type { HandlerInput } from "../dispatch/index.ts";
import type { Containment, Located, Viewer } from "./containment.ts";

/** How long a minted URL works. Minting the same scope again returns the same
 * grant with its expiry moved out, so an open preview keeps working while it is
 * being used and a forgotten one stops on its own. */
const GRANT_MS = 30 * 60 * 1000;

/** The placeholder a configured origin puts the grant id in.
 *
 * The id travels in a hostname, so where it goes is a deployment fact — which
 * label, under which domain — rather than something this code can derive. The
 * operator writes the origin with this in it, and an origin without it is not a
 * sandbox origin at all. */
const GID = "{gid}";

/** The capability the two sandbox ops need, present only where a sandbox origin
 * is configured: a grant with nowhere to be served from is a URL that answers
 * nothing, and a client is told before it asks. */
export function sandboxCapabilities(origin?: string): Capability[] {
  return isSandboxOrigin(origin) ? ["sandbox"] : [];
}

export function isSandboxOrigin(origin?: string): origin is string {
  return origin !== undefined && origin.includes(GID);
}

interface Grant {
  readonly gid: string;
  readonly token: string;
  readonly sid: Sid;
  readonly kind: Located["kind"];
  /** What the URL is relative to. A directory for the two surfaces that have
   * one, so a page's own stylesheet loads beside it; the file itself for
   * `external`, whose allowlist is single files (DR-0030 §4.1.1). */
  readonly root: string;
  expires_at: Timestamp;
}

/** The grants this instance has minted.
 *
 * They live in memory and die with the process (M4): a grant is re-mintable
 * from the same button that made it, so writing one down would persist a value
 * that can be reconstructed — and an expiry that outlived the daemon holding it
 * is not what a restart should mean.
 *
 * A grant widens nothing. The same containment check the matching read performs
 * runs when the URL is minted, and every request the URL serves resolves the
 * path again, so this can only ever fail the way that read would. */
export class SandboxGrants {
  readonly #byGid = new Map<string, Grant>();
  /** `sid` and the scope root, which is what a repeated mint reuses. */
  readonly #byScope = new Map<string, Grant>();

  constructor(
    private readonly paths: Containment,
    private readonly origin: string,
  ) {}

  async mint(
    args: SandboxGrantArgs,
    viewer: Viewer = {},
    now: Timestamp = Date.now(),
  ): Promise<SandboxGrantResult> {
    const at = await this.paths.locate(args, viewer);
    const root = at.kind === "external" ? at.real : dirname(at.real);
    // The two halves that are held to a spelling come first — a session id is
    // a uuid and a kind is one of three words (contract, `Sid` / `PathKind`) —
    // so the first two `|` are where the key divides and the root, which is a
    // path and may carry anything, is what is left.
    const scope = `${args.sid}|${at.kind}|${root}`;
    const existing = this.#live(this.#byScope.get(scope), now);
    const grant: Grant = existing ?? {
      gid: newGid(),
      token: newToken(),
      sid: args.sid,
      kind: at.kind,
      root,
      expires_at: now + GRANT_MS,
    };
    grant.expires_at = now + GRANT_MS;
    this.#byGid.set(grant.gid, grant);
    this.#byScope.set(scope, grant);
    return {
      gid: grant.gid,
      token: grant.token,
      url: this.#url(grant, at),
      expires_at: grant.expires_at,
    };
  }

  /** Best effort by design: an unknown or already-expired grant is answered the
   * same as one that was there, because nothing a caller does depends on the
   * difference and stating it would make this an existence oracle. */
  revoke(args: SandboxRevokeArgs): SandboxRevokeResult {
    const grant = this.#byGid.get(args.gid);
    if (grant !== undefined) {
      this.#byGid.delete(grant.gid);
      for (const [scope, held] of this.#byScope) {
        if (held.gid === grant.gid) this.#byScope.delete(scope);
      }
    }
    return {};
  }

  /** A grant by id, for whoever serves the origin. Expired is the same as
   * absent, since the expiry is what bounds a grant's life. */
  find(gid: string, now: Timestamp = Date.now()): Grant | undefined {
    return this.#live(this.#byGid.get(gid), now);
  }

  #live(grant: Grant | undefined, now: Timestamp): Grant | undefined {
    if (grant === undefined) return undefined;
    if (grant.expires_at > now) return grant;
    this.#byGid.delete(grant.gid);
    return undefined;
  }

  /** `<origin with the gid in it>/<token>/<path below the scope root>`.
   *
   * The token is a path prefix rather than a query, so a page's relative
   * references carry it without being rewritten (DR-0030 §3.3). */
  #url(grant: Grant, at: Located): string {
    const base = `${this.origin.replaceAll(GID, grant.gid)}/${grant.token}`;
    const below = at.real === grant.root ? "" : at.real.slice(grant.root.length + 1);
    return below === "" ? base : `${base}/${below.split("/").map(encodeURIComponent).join("/")}`;
  }
}

/** The two ops that mint and end a grant.
 *
 * Neither states a role: the attribute table gives them no `scope`, so there is
 * no visible range to narrow and what a grant refuses is exactly what the
 * matching read refuses. */
export function sandboxHandlers(grants: SandboxGrants) {
  return {
    "sandbox.grant": (input: HandlerInput): Promise<SandboxGrantResult> =>
      grants.mint(input.args as unknown as SandboxGrantArgs),
    "sandbox.revoke": (input: HandlerInput): SandboxRevokeResult =>
      grants.revoke(input.args as unknown as SandboxRevokeArgs),
  };
}

/** Lowercase base32, which is what a hostname label may hold. */
function newGid(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return [...randomBytes(16)].map((byte) => alphabet[byte % 32]).join("");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}
