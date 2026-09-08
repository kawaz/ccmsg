import type { Role, Sid } from "@ccmsg/protocol";

/** What dispatch knows about the connection a frame arrived on.
 *
 * transport settles this (daemon-v2 §3.1): a connection starts anonymous and
 * becomes `settled` when `hello` binds a role, and a session's `sid`, to it.
 * Nothing else about the connection reaches dispatch — the authorization steps
 * read the op attribute table, not the connection. */
export type ConnIdentity = AnonymousIdentity | SettledIdentity;

export interface AnonymousIdentity {
  readonly state: "anonymous";
}

export interface SettledIdentity {
  readonly state: "settled";
  readonly role: Role;
  /** Present when the role is a session, which is the only role that names one. */
  readonly sid?: Sid;
}

export const ANONYMOUS: AnonymousIdentity = { state: "anonymous" };
