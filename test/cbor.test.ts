import { describe, expect, test } from "bun:test";
import {
  CborError,
  type CborValue,
  decodeCbor,
  decodeCborWhole,
  mapEntry,
} from "../src/auth/index.ts";

/** Bytes, written the way a test reads best: `0x` pairs in one string. */
function bytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex.replaceAll(/\s+/g, ""), "hex"));
}

/** What a decode refused, or `undefined` when it did not refuse. */
function refusal(input: Uint8Array): string | undefined {
  try {
    decodeCborWhole(input);
    return undefined;
  } catch (cause) {
    if (!(cause instanceof CborError)) throw cause;
    return cause.message;
  }
}

describe("the encoding an authenticator's two values arrive in (DR-0001 §2.10)", () => {
  test("the five major types those values use are read", () => {
    // 0: unsigned, 1: negative, 2: bytes, 3: text, 4: array, 5: map, and the
    // three simple values an attestation statement may carry.
    expect(decodeCborWhole(bytes("00"))).toBe(0);
    expect(decodeCborWhole(bytes("17"))).toBe(23);
    expect(decodeCborWhole(bytes("1818"))).toBe(24);
    expect(decodeCborWhole(bytes("190100"))).toBe(256);
    expect(decodeCborWhole(bytes("1a00010000"))).toBe(65_536);
    // -1 - 0 and -1 - 256: the form a COSE key's negative labels take.
    expect(decodeCborWhole(bytes("20"))).toBe(-1);
    expect(decodeCborWhole(bytes("390100"))).toBe(-257);
    expect(decodeCborWhole(bytes("43010203"))).toEqual(bytes("010203"));
    expect(decodeCborWhole(bytes("63666d74"))).toBe("fmt");
    expect(decodeCborWhole(bytes("83010203"))).toEqual([1, 2, 3]);
    expect(decodeCborWhole(bytes("a1616101"))).toEqual(new Map<string, CborValue>([["a", 1]]));
    expect(decodeCborWhole(bytes("f4"))).toBe(false);
    expect(decodeCborWhole(bytes("f5"))).toBe(true);
    expect(decodeCborWhole(bytes("f6"))).toBe(null);
  });

  test("an attestation object's shape comes back as its three entries", () => {
    // `{"fmt": "none", "attStmt": {}, "authData": h'0102'}`, which is what an
    // authenticator making no statement about itself sends.
    const object = decodeCborWhole(
      bytes("a3 63666d74 646e6f6e65 6761747453746d74 a0 686175746844617461 420102"),
    );
    expect(mapEntry(object, "fmt")).toBe("none");
    expect(mapEntry(object, "attStmt")).toEqual(new Map());
    expect(mapEntry(object, "authData")).toEqual(bytes("0102"));
    // A key the object does not hold is absent rather than a fault, and a
    // value that is not a map holds nothing at all.
    expect(mapEntry(object, "nothing")).toBeUndefined();
    expect(mapEntry(42, "fmt")).toBeUndefined();
  });

  test("a value that stops part-way is refused rather than read as what is there", () => {
    // A byte string, a text string, an array, a map and an argument, each cut
    // short of what its own header promised.
    expect(refusal(bytes("43 0102"))).toBe("a byte string runs past the end");
    expect(refusal(bytes("63 666d"))).toBe("a text string runs past the end");
    expect(refusal(bytes("83 0102"))).toBe("the value runs past the end");
    expect(refusal(bytes("a2 6161 01"))).toBe("the value runs past the end");
    expect(refusal(bytes("19 01"))).toBe("the value runs past the end");
    expect(refusal(bytes(""))).toBe("the value runs past the end");
  });

  test("bytes after the value mean the value was not what the encoder said", () => {
    expect(refusal(bytes("00 00"))).toBe("1 bytes follow the value");
    // The remainder is answered rather than refused for the caller that reads
    // one value out of a longer run.
    expect(decodeCbor(bytes("00 ff"))).toEqual({ value: 0, rest: 1 });
  });

  test("a value nothing but nesting is refused before it costs a frame each", () => {
    // Arrays of one array, past the depth the two real shapes reach.
    const deep = bytes("81".repeat(64));
    expect(refusal(deep)).toBe("this value nests too deeply to be read here");
    // The bound is on nesting rather than on length: a map of three entries
    // holding a map of five is what a real attestation object is.
    expect(refusal(bytes(`a1 6161 ${"81".repeat(6)} 00`))).toBeUndefined();
  });

  test("what no conforming authenticator sends is refused rather than grown toward", () => {
    // Major type 6 is a tag, which nothing here reads.
    expect(refusal(bytes("c074"))).toBe("major type 6 is not read here");
    // 31 in the low bits is an indefinite length; WebAuthn requires the
    // canonical encoding, where every length is definite.
    expect(refusal(bytes("9f 00 ff"))).toBe("length form 31 is not read here");
    expect(refusal(bytes("5f 41 00 ff"))).toBe("length form 31 is not read here");
    // 27 is a 64-bit argument: a length this process would not then allocate.
    expect(refusal(bytes("1b 0000000100000000"))).toBe("length form 27 is not read here");
    // The simple values other than the three an attestation statement carries.
    expect(refusal(bytes("f7"))).toBe("simple value 23 is not read here");
    expect(refusal(bytes("fb 3ff0000000000000"))).toBe("simple value 27 is not read here");
  });

  test("a map key that is neither an integer nor a string is refused", () => {
    // `{h'01': 1}` — a byte string as a key, which neither shape uses.
    expect(refusal(bytes("a1 4101 01"))).toBe("a map key here is an integer or a string");
  });
});
