/**
 * Environment-driven configuration: the HAGEZI_UPSTREAM_ENDPOINTS override and
 * the trusted-proxy boundary (TRUST_PROXY_HEADERS), including its default-on
 * behavior, which the other suites can override explicitly.
 *
 * Both variables are set BEFORE the modules load: the override list is read
 * once on first use, and node:test runs every file in its own process, so this
 * file gets a fresh module instance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { importDoh, libUrl } from "./lib/transpile-source.mjs";

delete process.env.TRUST_PROXY_HEADERS;
delete process.env.HAGEZI_ROTATION_MODE;
delete process.env.HAGEZI_ROTATION_SECONDS;
process.env.HAGEZI_UPSTREAM_ENDPOINTS = " https://one.test/dns-query , not a url,, http://two.test:8443/q ";

const doh = await importDoh();
const clientIp = await import(await libUrl("client-ip"));

const DNS_MESSAGE = "application/dns-message";

function validQuery() {
  return Uint8Array.from([
    0x12, 0x34,
    0x01, 0x00,
    0x00, 0x01,
    0x00, 0x00,
    0x00, 0x00,
    0x00, 0x00,
    3, 119, 119, 119,
    7, 101, 120, 97, 109, 112, 108, 101,
    0,
    0, 1,
    0, 1,
  ]);
}

function validResponse(query = validQuery()) {
  return Uint8Array.from([
    query[0], query[1],
    0x81, 0x80,
    0x00, 0x01,
    0x00, 0x01,
    0x00, 0x00,
    0x00, 0x00,
    ...query.slice(12),
    0xc0, 0x0c,
    0x00, 0x01,
    0x00, 0x01,
    0x00, 0x00, 0x00, 0x3c,
    0x00, 0x04, 1, 2, 3, 4,
  ]);
}

test("HAGEZI_UPSTREAM_ENDPOINTS replaces the built-in list, trims entries and ignores invalid ones", () => {
  const upstreams = doh.getHageziUpstreams();
  assert.deepEqual(
    upstreams.map((upstream) => upstream.endpoint),
    ["https://one.test/dns-query", "http://two.test:8443/q"],
  );
  assert.ok(upstreams.every((upstream) => upstream.url instanceof URL));
});

test("the override is not rotated, in either rotation mode, and is read only once", () => {
  const realNow = Date.now;
  const savedMode = process.env.HAGEZI_ROTATION_MODE;
  try {
    const expected = doh.getHageziUpstreams().map((upstream) => upstream.endpoint);
    for (const mode of [undefined, "request"]) {
      if (mode === undefined) delete process.env.HAGEZI_ROTATION_MODE;
      else process.env.HAGEZI_ROTATION_MODE = mode;
      for (let i = 0; i < 4; i += 1) {
        Date.now = () => realNow() + i * 3_600_000;
        assert.deepEqual(doh.getHageziUpstreams().map((upstream) => upstream.endpoint), expected);
      }
    }

    process.env.HAGEZI_UPSTREAM_ENDPOINTS = "https://changed.test/dns-query";
    assert.deepEqual(doh.getHageziUpstreams().map((upstream) => upstream.endpoint), expected, "later changes are ignored");
  } finally {
    Date.now = realNow;
    if (savedMode === undefined) delete process.env.HAGEZI_ROTATION_MODE;
    else process.env.HAGEZI_ROTATION_MODE = savedMode;
  }
});

test("forwarding headers are trusted only for explicit truthy TRUST_PROXY_HEADERS values", () => {
  const enabled = (value) => clientIp.isProxyTrustEnabled(value === undefined ? {} : { TRUST_PROXY_HEADERS: value });
  for (const value of ["1", "true", "TRUE", " yes ", "on"]) assert.equal(enabled(value), true, JSON.stringify(value));
  for (const value of ["0", "false", "off", "no"]) assert.equal(enabled(value), false, JSON.stringify(value));
  for (const value of [undefined, ""]) assert.equal(enabled(value), true, JSON.stringify(value));
  for (const value of ["2", "enabled"]) assert.equal(enabled(value), false, JSON.stringify(value));
});

test("getClientIp ignores X-Real-IP / X-Forwarded-For unless trusted (and is untrusted by default)", () => {
  const spoofed = new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" });
  assert.equal(clientIp.getClientIp(spoofed, false), undefined);
  assert.equal(clientIp.getClientIp(spoofed), "203.0.113.9", "the environment default trusts forwarding headers");
  assert.equal(clientIp.getClientIp(spoofed, true), "203.0.113.9", "X-Real-IP wins when trusted");
});

test("getClientIp uses the LAST usable X-Forwarded-For entry and never falls back past an invalid one", () => {
  const xff = (value, extra = {}) => new Headers({ "x-forwarded-for": value, ...extra });
  assert.equal(clientIp.getClientIp(xff("6.6.6.6, 2.2.2.2"), true), "2.2.2.2");
  assert.equal(clientIp.getClientIp(xff("2.2.2.2, "), true), "2.2.2.2", "trailing empty entries are skipped");
  assert.equal(clientIp.getClientIp(xff("2.2.2.2, junk"), true), undefined, "an unusable last entry yields no identity");
  assert.equal(clientIp.getClientIp(xff("2.2.2.2", { "x-real-ip": "not-an-ip" }), true), "2.2.2.2", "bad X-Real-IP falls back to XFF");
});

test("normalizeIp strips ports, brackets and zones, collapses IPv4-mapped IPv6 and keys IPv6 by /64", () => {
  const cases = new Map([
    ["1.2.3.4", "1.2.3.4"],
    ["1.2.3.4:8080", "1.2.3.4"],
    ["::ffff:1.2.3.4", "1.2.3.4"],
    ["[::ffff:1.2.3.4]:99", "1.2.3.4"],
    ["[2001:db8::1]:443", "2001:db8:0:0::/64"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["garbage", undefined],
    ["999.1.1.1", undefined],
    ["   ", undefined],
  ]);
  for (const [raw, expected] of cases) assert.equal(clientIp.normalizeIp(raw), expected, JSON.stringify(raw));
});

test("with TRUST_PROXY_HEADERS explicitly disabled no per-IP in-flight cap applies, only the global ceiling", async () => {
  process.env.TRUST_PROXY_HEADERS = "0";
  const originalFetch = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await gate;
    return new Response(validResponse(), { status: 200, headers: { "content-type": DNS_MESSAGE } });
  };
  try {
    const dns = Buffer.from(validQuery()).toString("base64url");
    const options = { upstreams: [{ endpoint: "https://untrusted.test/dns-query" }], timeoutMs: 2_000, failover: false };
    const count = doh.MAX_IN_FLIGHT_PER_IP + 1;
    const held = Array.from({ length: count }, () =>
      doh.proxyRequest(
        new Request(`https://proxy.test/api/doh/dns-query?dns=${dns}`, { headers: { "x-real-ip": "192.0.2.50" } }),
        options,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, count, "every request was admitted despite sharing one claimed IP");
    release();
    assert.ok((await Promise.all(held)).every((response) => response.status === 200));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
