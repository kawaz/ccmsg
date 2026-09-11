import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InstanceId } from "@ccmsg/protocol";

/** How much randomness an instance id carries. Sixteen bytes is the width at
 * which two independently generated ids do not collide for any number of
 * instances a person runs, and it is what the contract's fixed-width hex
 * spelling is sized for. */
const ID_BYTES = 16;

export const ID = /^[0-9a-f]{32}$/;

/** A fresh id of that width, for whatever is being named.
 *
 * One generator rather than one per kind of id: what an id has to be is
 * unguessable-by-accident and the same width wherever it is read, and a second
 * generator is a second answer to how wide that is. */
export function newId(): string {
  return randomBytes(ID_BYTES).toString("hex");
}

/** This instance's identity, read from the state directory and generated there
 * the first time it is asked for.
 *
 * It is written down rather than derived because everything that has to survive
 * the instance moving is keyed by it — `mid`, the store's keys, `last_live`,
 * the issuer of a credential record — and a value derived from where the
 * instance currently is would change exactly when those must not. Moving an
 * instance is moving this directory.
 *
 * Not a secret: it names the instance to every peer and to every client, and
 * the file's mode says so. What it is worth protecting from is loss, which is
 * the state directory's concern rather than this file's. */
export function instanceIdentity(file: string): InstanceId {
  const held = read(file);
  if (held !== undefined) return held;
  const made = newId();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${made}\n`);
  return made;
}

function read(file: string): InstanceId | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const id = text.trim();
  return ID.test(id) ? id : undefined;
}
