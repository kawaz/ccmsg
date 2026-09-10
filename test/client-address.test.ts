import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookieName } from "../src/auth/index.ts";
import { clientAddress, parseCidr, trusted } from "../src/instance/client.ts";
import { loadConfig } from "../src/instance/config.ts";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";

/** Where a request came from when a proxy is in front of the instance (§3.1).
 *
 * The blocks are exercised as a judgement of their own, and the header on top
 * of them, because the two fail in different ways: a block that reads an
 * address wrongly trusts the wrong hop, and a header read wrongly keeps a value
 * the hop never vouched for. */

const running: Instance[] = [];

afterEach(async () => {
  for (const instance of running.splice(0)) await instance.stop();
});

function blocks(...texts: string[]) {
  return texts.map((text) => {
    const block = parseCidr(text);
    if (block === undefined) throw new Error(`${text} did not parse`);
    return block;
  });
}

/** A request with the forwarding header a proxy would have written. */
function forwarded(header?: string): Request {
  return new Request("http://ui.example.com/auth/refresh", {
    method: "POST",
    ...(header === undefined ? {} : { headers: { "x-forwarded-for": header } }),
  });
}

describe("the address blocks an operator names", () => {
  test("an address is inside a block by its bits, on either family", () => {
    const v4 = blocks("10.0.0.0/8", "192.168.1.0/24");
    expect(trusted("10.255.255.254", v4)).toBe(true);
    expect(trusted("11.0.0.1", v4)).toBe(false);
    expect(trusted("192.168.1.255", v4)).toBe(true);
    expect(trusted("192.168.2.0", v4)).toBe(false);

    const v6 = blocks("2001:db8::/32", "fd00::/8");
    expect(trusted("2001:db8:1234::1", v6)).toBe(true);
    expect(trusted("2001:db9::1", v6)).toBe(false);
    expect(trusted("fd12:3456::9", v6)).toBe(true);
    expect(trusted("fe80::1", v6)).toBe(false);
  });

  test("the bit at the edge of a block decides it", () => {
    // /31 fixes everything but the last bit, so exactly two addresses are in.
    const edge = blocks("203.0.113.2/31");
    expect(trusted("203.0.113.2", edge)).toBe(true);
    expect(trusted("203.0.113.3", edge)).toBe(true);
    expect(trusted("203.0.113.1", edge)).toBe(false);
    expect(trusted("203.0.113.4", edge)).toBe(false);

    // /0 is every address of its family, and /128 is one.
    expect(trusted("198.51.100.9", blocks("0.0.0.0/0"))).toBe(true);
    const one = blocks("2001:db8::5/128");
    expect(trusted("2001:db8::5", one)).toBe(true);
    expect(trusted("2001:db8::6", one)).toBe(false);

    // A bare address is the block holding it alone.
    expect(trusted("127.0.0.1", blocks("127.0.0.1"))).toBe(true);
    expect(trusted("127.0.0.2", blocks("127.0.0.1"))).toBe(false);
  });

  test("a block fixes bits of one family, so the other family is outside it", () => {
    expect(trusted("::1", blocks("0.0.0.0/0"))).toBe(false);
    expect(trusted("127.0.0.1", blocks("::/0"))).toBe(false);
  });

  test("two spellings of one address are one address", () => {
    // An IPv4-mapped address is the IPv4 address, so an operator writes the
    // block once.
    expect(trusted("::ffff:127.0.0.1", blocks("127.0.0.0/8"))).toBe(true);
    expect(trusted("::ffff:7f00:1", blocks("127.0.0.0/8"))).toBe(true);
    expect(trusted("0:0:0:0:0:0:0:1", blocks("::1/128"))).toBe(true);
    // A zone id names an interface, not another address.
    expect(trusted("fe80::1%en0", blocks("fe80::/10"))).toBe(true);
  });

  test("what is not an address block does not parse", () => {
    for (const text of [
      "",
      "10.0.0.1/33",
      "10.0.0.1/x",
      "10.0.0.256",
      "0177.0.0.1",
      "10.0.0",
      "1:2:3::4::5",
      "2001:db8::/129",
      "2001:db8::gggg",
      "not-an-address",
    ]) {
      expect(parseCidr(text)).toBeUndefined();
    }
  });
});

describe("the address a forwarding header is believed for", () => {
  const proxies = blocks("127.0.0.0/8", "10.0.0.0/8");

  test("a proxy the operator named is believed", () => {
    expect(clientAddress(forwarded("203.0.113.7"), "127.0.0.1", proxies)).toBe("203.0.113.7");
  });

  test("anyone else's header is a claim about somebody else, and is dropped", () => {
    expect(clientAddress(forwarded("203.0.113.7"), "198.51.100.4", proxies)).toBe("198.51.100.4");
    // An operator with no proxy in front of them trusts none of it.
    expect(clientAddress(forwarded("203.0.113.7"), "127.0.0.1", [])).toBe("127.0.0.1");
  });

  test("in a chain, the rightmost hop outside the chain is the answer", () => {
    // Written by the outermost proxy first: whoever was talking to it could put
    // anything to the left of what our own hops wrote.
    const chain = "1.2.3.4, 203.0.113.7, 10.0.0.9, 10.0.0.8";
    expect(clientAddress(forwarded(chain), "127.0.0.1", proxies)).toBe("203.0.113.7");
  });

  test("a chain of nothing but our own hops leaves the address we observed", () => {
    expect(clientAddress(forwarded("10.0.0.9, 10.0.0.8"), "127.0.0.1", proxies)).toBe("127.0.0.1");
    expect(clientAddress(forwarded(), "127.0.0.1", proxies)).toBe("127.0.0.1");
  });

  test("a header holding something that is not an address is not read at all", () => {
    // Rather than skipped over: a proxy writing one value we cannot read is a
    // proxy whose account of the rest we have no reason to piece together.
    expect(clientAddress(forwarded("203.0.113.7, nonsense"), "127.0.0.1", proxies)).toBe(
      "127.0.0.1",
    );
  });
});

describe("what the instance keeps (DR-0001 §2.2)", () => {
  let nextPort = 39_820;

  /** An instance whose config names the proxies the test wants. */
  async function serving(trusted_proxies: string[]): Promise<{ instance: Instance; port: number }> {
    const port = (nextPort += 1);
    const root = mkdtempSync(join(tmpdir(), "ccmsg-forwarded-"));
    mkdirSync(join(root, "home", "sessions"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "config.json"),
      JSON.stringify({ defaults: { entry: { host: "127.0.0.1", port, trusted_proxies } } }),
    );
    const env: Env = {
      CLAUDE_CONFIG_DIR: join(root, "home"),
      CCMSG_STATE_DIR: join(root, "state"),
      CCMSG_CONFIG_DIR: join(root, "config"),
    };
    const outcome = await start({ env, echoLog: false });
    if (!isRunning(outcome)) throw new Error("another instance holds this config home");
    running.push(outcome);
    return { instance: outcome, port };
  }

  /** A refresh as it arrives from a proxy: the person's cookie, and the header
   * that proxy wrote, with the address the listener observed stated as the
   * argument the transport would have passed. */
  async function refresh(
    at: { instance: Instance; port: number },
    value: string,
    from: { source: string; header?: string },
  ): Promise<Response | undefined> {
    const origin = `http://127.0.0.1:${String(at.port)}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin,
      cookie: `${cookieName(at.instance.self, "someone")}=${value}`,
    };
    if (from.header !== undefined) headers["x-forwarded-for"] = from.header;
    return await at.instance.route(
      new Request(`${origin}/auth/refresh`, { method: "POST", headers, body: "{}" }),
      from.source,
    );
  }

  test("a rotation behind a named proxy remembers the person's address", async () => {
    const at = await serving(["127.0.0.0/8"]);
    // A registration URL is what makes this instance's own origin one it
    // serves, which `/auth/*` is compared against before anything else (§2.3).
    at.instance.auth.issue({ endpoint: `http://127.0.0.1:${String(at.port)}/` });
    const minted = at.instance.auth.mint("someone");
    const answered = await refresh(at, minted.refresh.value, {
      source: "127.0.0.1",
      header: "203.0.113.7",
    });
    expect(answered?.status).toBe(200);
    expect(at.instance.auth.records.families()[0]?.body.last_refresh?.ip).toBe("203.0.113.7");
  });

  test("without the proxy named, the address the listener saw is what is kept", async () => {
    const at = await serving([]);
    // A registration URL is what makes this instance's own origin one it
    // serves, which `/auth/*` is compared against before anything else (§2.3).
    at.instance.auth.issue({ endpoint: `http://127.0.0.1:${String(at.port)}/` });
    const minted = at.instance.auth.mint("someone");
    const answered = await refresh(at, minted.refresh.value, {
      source: "127.0.0.1",
      header: "203.0.113.7",
    });
    expect(answered?.status).toBe(200);
    expect(at.instance.auth.records.families()[0]?.body.last_refresh?.ip).toBe("127.0.0.1");
  });

  test("a block that is not one is refused where it is written", () => {
    const root = mkdtempSync(join(tmpdir(), "ccmsg-forwarded-config-"));
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "config.json"),
      JSON.stringify({
        defaults: {
          entry: { host: "127.0.0.1", port: 0, trusted_proxies: ["10.0.0.0/8", "nope"] },
        },
      }),
    );
    const dir = join(root, "config");
    expect(() => loadConfig(join(dir, "config.json"), dir)).toThrow(/trusted_proxies/);
  });
});
