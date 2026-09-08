import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

/** The secret a WebSocket client presents to reach this instance.
 *
 * A4 puts the boundary at the uid and at file permissions rather than inside
 * the daemon, and that is exactly what this is: the token is a file only this
 * uid can read, so "may this client connect" is decided by whether it could
 * read that file. The daemon holds no accounts and checks no passwords — it
 * compares one string against the one it wrote.
 *
 * The unix socket needs none of this: reaching it already means passing the
 * directory's permissions. Only the WebSocket is reachable by anything that can
 * open a TCP connection to the bound address, which on a shared host is every
 * other uid on it. */
const TOKEN_BYTES = 32;

/** Read the instance's entry token, writing one if the file is not there.
 *
 * Hex rather than base64, because the token travels as a WebSocket subprotocol
 * value and those are HTTP tokens: an alphabet with no `+`, `/` or `=` needs no
 * escaping to survive the handshake. */
export function entryToken(file: string): string {
  const held = read(file);
  if (held !== undefined) return held;
  const made = randomBytes(TOKEN_BYTES).toString("hex");
  // Created unreadable to anyone else from the start: a token written 0644 and
  // narrowed afterwards is readable for the moment in between.
  writeFileSync(file, `${made}\n`, { mode: 0o600 });
  // An existing file keeps its own mode through `writeFileSync`, so the mode
  // above covers only the creation and this covers a file left behind by an
  // earlier run.
  chmodSync(file, 0o600);
  return made;
}

function read(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const token = text.trim();
  return token === "" ? undefined : token;
}

/** Whether a presented token is the instance's, compared in constant time so
 * the comparison itself says nothing about how much of it was right. */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  // `timingSafeEqual` requires equal lengths, and a length is not a secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
