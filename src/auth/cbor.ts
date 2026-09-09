/** Just enough CBOR to read what an authenticator hands over (DR-0001 §2.10).
 *
 * Two values arrive in this encoding and no others: the attestation object,
 * which is a map of three entries, and the COSE public key inside it, which is
 * a map keyed by small integers. So the decoder covers the five major types
 * those use — unsigned and negative integers, byte and text strings, arrays and
 * maps — and refuses everything else rather than growing toward a general
 * implementation nothing here would call.
 *
 * Indefinite lengths are refused for the same reason: WebAuthn requires
 * canonical CTAP2 encoding, where every length is definite, so accepting one
 * would be accepting something no conforming authenticator produces.
 *
 * Nesting is bounded because the input is attacker-supplied: a value that is
 * nothing but a few thousand nested arrays costs one byte each to write and a
 * stack frame each to read, and this decoder runs on a route reachable before
 * anything is proven. */

export class CborError extends Error {}

/** How deep a value may nest. The two shapes this reads are a map of three
 * entries holding a map of five, so anything past a handful is not one of
 * them. */
const MAX_DEPTH = 8;

/** One decoded value, and where the next one starts. */
interface Read<T> {
  readonly value: T;
  readonly next: number;
}

export type CborValue =
  | number
  | string
  | Uint8Array
  | CborValue[]
  | Map<number | string, CborValue>
  | boolean
  | null;

/** Decode one value, and say how many bytes were left after it.
 *
 * The remainder is answered rather than ignored because trailing bytes mean
 * the value was not what the encoder said it was, and the caller — which knows
 * whether its input is exactly one value — is where that is worth refusing. */
export function decodeCbor(bytes: Uint8Array): { value: CborValue; rest: number } {
  const read = value(bytes, 0, 0);
  return { value: read.value, rest: bytes.length - read.next };
}

/** Decode one value that is the whole of the input. */
export function decodeCborWhole(bytes: Uint8Array): CborValue {
  const { value: decoded, rest } = decodeCbor(bytes);
  if (rest !== 0) throw new CborError(`${String(rest)} bytes follow the value`);
  return decoded;
}

function value(bytes: Uint8Array, at: number, depth: number): Read<CborValue> {
  if (depth > MAX_DEPTH) throw new CborError("this value nests too deeply to be read here");
  const initial = byte(bytes, at);
  const major = initial >> 5;
  const minor = initial & 0x1f;
  switch (major) {
    case 0: {
      const read = argument(bytes, at + 1, minor);
      return { value: read.value, next: read.next };
    }
    case 1: {
      const read = argument(bytes, at + 1, minor);
      return { value: -1 - read.value, next: read.next };
    }
    case 2: {
      const read = argument(bytes, at + 1, minor);
      const end = read.next + read.value;
      if (end > bytes.length) throw new CborError("a byte string runs past the end");
      return { value: bytes.subarray(read.next, end), next: end };
    }
    case 3: {
      const read = argument(bytes, at + 1, minor);
      const end = read.next + read.value;
      if (end > bytes.length) throw new CborError("a text string runs past the end");
      return { value: new TextDecoder().decode(bytes.subarray(read.next, end)), next: end };
    }
    case 4: {
      const read = argument(bytes, at + 1, minor);
      const items: CborValue[] = [];
      let cursor = read.next;
      for (let i = 0; i < read.value; i += 1) {
        const item = value(bytes, cursor, depth + 1);
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    case 5: {
      const read = argument(bytes, at + 1, minor);
      const entries = new Map<number | string, CborValue>();
      let cursor = read.next;
      for (let i = 0; i < read.value; i += 1) {
        const key = value(bytes, cursor, depth + 1);
        if (typeof key.value !== "number" && typeof key.value !== "string") {
          throw new CborError("a map key here is an integer or a string");
        }
        const held = value(bytes, key.next, depth + 1);
        entries.set(key.value, held.value);
        cursor = held.next;
      }
      return { value: entries, next: cursor };
    }
    case 7: {
      // The three simple values that appear in an attestation statement.
      if (minor === 20) return { value: false, next: at + 1 };
      if (minor === 21) return { value: true, next: at + 1 };
      if (minor === 22) return { value: null, next: at + 1 };
      throw new CborError(`simple value ${String(minor)} is not read here`);
    }
    default:
      throw new CborError(`major type ${String(major)} is not read here`);
  }
}

/** The count, length or value an initial byte's low bits introduce. */
function argument(bytes: Uint8Array, at: number, minor: number): Read<number> {
  if (minor < 24) return { value: minor, next: at };
  if (minor === 24) return { value: byte(bytes, at), next: at + 1 };
  if (minor === 25) return { value: (byte(bytes, at) << 8) | byte(bytes, at + 1), next: at + 2 };
  if (minor === 26) {
    const held =
      byte(bytes, at) * 0x1000000 +
      (byte(bytes, at + 1) << 16) +
      (byte(bytes, at + 2) << 8) +
      byte(bytes, at + 3);
    return { value: held, next: at + 4 };
  }
  // 27 is a 64-bit argument and 31 is an indefinite length. Neither appears in
  // what an authenticator sends, and a length past 2^32 is not something this
  // process would then go on to allocate.
  throw new CborError(`length form ${String(minor)} is not read here`);
}

function byte(bytes: Uint8Array, at: number): number {
  const held = bytes[at];
  if (held === undefined) throw new CborError("the value runs past the end");
  return held;
}

/** One entry of a decoded map, refusing when the value is not what was wanted. */
export function mapEntry(value: CborValue, key: number | string): CborValue | undefined {
  return value instanceof Map ? value.get(key) : undefined;
}
