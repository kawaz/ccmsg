/** Where a request came from, when something in front of us is forwarding it
 * (§3.1).
 *
 * The address the listener observed is the one thing here that cannot be
 * claimed, and behind a reverse proxy it is always the proxy's. `X-Forwarded-*`
 * carries what the proxy saw, but the header is a header: anyone who can reach
 * the port can write one. The operator names the proxies as CIDR blocks, which
 * is the only way this instance can tell a forwarding it asked for from a
 * forwarding a caller invented.
 *
 * What is recovered is a hint and not a credential — an address is what a
 * person recognises their own session by (DR-0001 §2.2), and nothing is
 * admitted or refused by it. That is also why a wrong answer here is worse than
 * no answer: a forged address kept on a record is a hint pointing away from
 * whoever reads it.
 */

/** One address block, as the operator wrote it. Held as the address's bytes and
 * how many of its leading bits the block fixes. */
interface Cidr {
  readonly bytes: Uint8Array;
  readonly bits: number;
}

/** Parse an address, or answer nothing for a text that is not one.
 *
 * IPv4 and IPv6 are both read to bytes here rather than compared as text: a
 * block is a run of bits, and two spellings of one address (`::ffff:127.0.0.1`
 * and `127.0.0.1`, `::1` and `0:0:0:0:0:0:0:1`) are the same address. An
 * IPv4-mapped IPv6 address is answered as its four IPv4 bytes, so an operator
 * who wrote `127.0.0.0/8` is not asked to also write the mapped spelling of it.
 */
export function addressBytes(text: string): Uint8Array | undefined {
  // A zone id names an interface on the host that holds the address, and says
  // nothing about which address it is.
  const bare = text.includes("%") ? text.slice(0, text.indexOf("%")) : text;
  if (bare === "") return undefined;
  return bare.includes(":") ? ipv6Bytes(bare) : ipv4Bytes(bare);
}

function ipv4Bytes(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    // Leading zeros are refused rather than read: `0177.0.0.1` is one address
    // to a library that reads it as octal and another to one that does not, and
    // an address this instance is unsure of is not one to trust a header by.
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes[index] = value;
  }
  return bytes;
}

function ipv6Bytes(text: string): Uint8Array | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) return undefined;
  // The address's last group may be written as a dotted IPv4, which is how a
  // mapped address is spelled; it stands for the two groups it fills.
  const last = tail.length > 0 ? tail : head;
  const trailing = last[last.length - 1];
  let embedded: Uint8Array | undefined;
  if (trailing !== undefined && trailing.includes(".")) {
    embedded = ipv4Bytes(trailing);
    if (embedded === undefined) return undefined;
    last.pop();
  }
  const front = bytesOfGroups(head);
  const back = bytesOfGroups(tail);
  if (front === undefined || back === undefined) return undefined;
  const stated = front.length + back.length + (embedded === undefined ? 0 : 4);
  // Without `::` the groups are the whole address; with it they are less than
  // the whole, since it has to stand for at least one group of zeros.
  if (halves.length === 1 ? stated !== 16 : stated > 14) return undefined;
  const bytes = new Uint8Array(16);
  bytes.set(front, 0);
  const rest = new Uint8Array([...back, ...(embedded ?? [])]);
  bytes.set(rest, 16 - rest.length);
  return mappedV4(bytes) ?? bytes;
}

function bytesOfGroups(groups: readonly string[]): Uint8Array | undefined {
  const bytes = new Uint8Array(groups.length * 2);
  for (const [index, group] of groups.entries()) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** The four IPv4 bytes of an IPv4-mapped address (`::ffff:0:0/96`), if it is
 * one. Held as IPv4 so that one written block covers both spellings. */
function mappedV4(bytes: Uint8Array): Uint8Array | undefined {
  for (let index = 0; index < 10; index += 1) if (bytes[index] !== 0) return undefined;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return undefined;
  return bytes.slice(12);
}

function groupsOf(half: string): string[] | undefined {
  if (half === "") return [];
  const groups = half.split(":");
  return groups.some((group) => group === "") ? undefined : groups;
}

/** Parse `<address>/<bits>`, or a bare address as the block holding it alone.
 * Answers nothing for a text that is not a block, which is what lets config
 * refuse it at load rather than silently trusting nobody. */
export function parseCidr(text: string): Cidr | undefined {
  const slash = text.lastIndexOf("/");
  const address = slash === -1 ? text : text.slice(0, slash);
  const bytes = addressBytes(address);
  if (bytes === undefined) return undefined;
  const width = bytes.length * 8;
  if (slash === -1) return { bytes, bits: width };
  const suffix = text.slice(slash + 1);
  if (!/^(?:0|[1-9][0-9]?[0-9]?)$/.test(suffix)) return undefined;
  const bits = Number(suffix);
  if (bits > width) return undefined;
  return { bytes, bits };
}

function within(address: Uint8Array, block: Cidr): boolean {
  // A block fixes bits of one family, so an address of the other is outside it.
  if (address.length !== block.bytes.length) return false;
  const whole = block.bits >> 3;
  for (let index = 0; index < whole; index += 1) {
    if (address[index] !== block.bytes[index]) return false;
  }
  const rest = block.bits & 7;
  if (rest === 0) return true;
  const mask = 0xff << (8 - rest);
  return ((address[whole] ?? 0) & mask) === ((block.bytes[whole] ?? 0) & mask);
}

/** Whether an address is one of the named blocks. */
export function trusted(address: string | undefined, blocks: readonly Cidr[]): boolean {
  if (address === undefined || blocks.length === 0) return false;
  const bytes = addressBytes(address);
  if (bytes === undefined) return false;
  return blocks.some((block) => within(bytes, block));
}

/** The address the person is at, as far as this instance can tell.
 *
 * The observed address when it is not a proxy the operator named — a header
 * from anyone else is a claim about somebody else and is dropped. When it is
 * one, `X-Forwarded-For` is read from the right and the first address that is
 * not itself a trusted proxy is answered: the entries to the right were written
 * by the proxies in the chain, and the first one outside that chain is the last
 * value this instance has any reason to believe. Everything further left was
 * written by whoever was talking to the outermost proxy and could say anything.
 *
 * A chain of nothing but trusted proxies leaves the observed address, which is
 * the honest answer when every value in the header is one of our own hops.
 */
export function clientAddress(
  request: Request,
  observed: string | undefined,
  proxies: readonly Cidr[],
): string | undefined {
  if (!trusted(observed, proxies)) return observed;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded === null) return observed;
  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index] ?? "";
    if (addressBytes(hop) === undefined) return observed;
    if (!trusted(hop, proxies)) return hop;
  }
  return observed;
}

export type { Cidr };
