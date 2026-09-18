import type { Instance } from "../src/instance/index.ts";
import { type Auth, credentialKey } from "../src/auth/index.ts";

/** A person's id, spelled the one way the contract spells one: sixteen bytes of
 * base64url, whose last character carries the four bits that have nowhere to go
 * (contract, `UserId`).
 *
 * Fixed rather than random so a test that prints one reads the same twice. */
export const TEST_USER = "AAAAAAAAAAAAAAAAAAAAAQ";
export const OTHER_USER = "AAAAAAAAAAAAAAAAAAAAAg";

/** An access token for a person who owns this instance.
 *
 * A WebSocket handshake presents one, and a test has no browser and no
 * authenticator — so it writes down what a registration would have written (the
 * granting that admits them) and asks for the session `/auth/assert` would have
 * answered with. Both halves are needed: a token says who the person is, and
 * ownership is what lets them in (contract, DR-0030 §3). */
export async function personToken(
  instance: Instance,
  user: string = TEST_USER,
  origin?: string,
): Promise<string> {
  return (await personSession(instance.auth, instance, user, origin)).access.value;
}

/** Write down that this person has a passkey at this origin, which is the only
 * thing that makes the origin one the instance answers CORS for (contract,
 * DR-0030 §9). A test has no authenticator, so the record is written directly;
 * nothing here verifies anything with it. */
export async function knownAt(auth: Auth, origin: string, user: string = TEST_USER): Promise<void> {
  await auth.grant(user, [auth.self], { kind: "instance", instance: auth.self });
  const credentialId = `${user}-at-${Buffer.from(origin).toString("base64url")}`;
  await auth.records.write(credentialKey(credentialId), {
    kind: "credential",
    user,
    credential_id: credentialId,
    public_key: "AA",
    origin,
    registered_at: Date.now(),
  });
}

export async function personSession(
  auth: Auth,
  instance: Instance,
  user: string = TEST_USER,
  origin?: string,
) {
  const at = origin ?? `http://${instance.http[0] as string}`;
  await auth.grant(user, [auth.self], { kind: "instance", instance: auth.self });
  return (await auth.mint(user, at)).session;
}
