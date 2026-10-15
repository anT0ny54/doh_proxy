/**
 * Environment-driven configuration (src/lib/config.ts) and client identity
 * (src/lib/client-ip.ts). Configuration is parsed once per module instance;
 * suites load fresh instances after changing process.env.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dnsAnswer, validQuery } from "./lib/dns-fixtures.mjs";
import { importDoh, importSource } from "./lib/transpile-source.mjs";

const config = await importSource("lib/config.ts");
const clientIp = await importSource("lib/client-ip.ts");

const DEFAULT_IDENTITY = { trustProxyHeaders: true, clientIpHeaders: ["x-forwarded-for"], trustedProxyHops: 1 };

test("defaults: trust on, 100/min, self-hosted X-Forwarded-For, 1800 s time-slot rotation", () => {
  const loaded = config.loadConfig({});
  assert.equal(loaded.trustProxyHeaders, true);
  assert.equal(loaded.rateLimitPerMinute, 100);
  assert.equal(loaded.platform, "self-hosted");
  assert.deepEqual(loaded.clientIpHeaders, ["x-forwarded-for"]);
  assert.equal(loaded.trustedProxyHops, 1);
  assert.equal(loaded.hageziRotationSeconds, 1_800);
  assert.equal(loaded.hageziRotationPerRequest, false);
  assert.deepEqual(loaded.hageziUpstreamEndpoints, []);
  assert.ok(Object.isFrozen(loaded));
});

test("TRUST_PROXY_HEADERS: unset/empty/truthy enable trust, anything else disables it", () => {
  for (const value of [undefined, "", "1", "true", "TRUE", " yes ", "on"]) assert.equal(config.parseTrust(value), true, JSON.stringify(value));
  for (const value of ["0", "false", "off", "no", "2", "enabled"]) assert.equal(config.parseTrust(value), false, JSON.stringify(value));
});

test("platform defaults pick the header the platform edge sets itself", () => {
  assert.deepEqual(config.loadConfig({ DOH_BUILD_PLATFORM: "vercel" }).clientIpHeaders, ["x-real-ip", "x-forwarded-for"]);
  assert.deepEqual(config.loadConfig({ DOH_BUILD_PLATFORM: "netlify" }).clientIpHeaders, ["x-nf-client-connection-ip"]);
  assert.equal(config.loadConfig({ VERCEL: "1" }).platform, "vercel");
  assert.deepEqual(
    config.loadConfig({ DOH_BUILD_PLATFORM: "netlify", CLIENT_IP_HEADERS: " CF-Connecting-IP , x-real-ip " }).clientIpHeaders,
    ["cf-connecting-ip", "x-real-ip"],
    "CLIENT_IP_HEADERS overrides the platform default",
  );
});

test("numeric settings are validated and clamped", () => {
  const load = (env) => config.loadConfig(env);
  assert.equal(load({ RATE_LIMIT_PER_MINUTE: "250" }).rateLimitPerMinute, 250);
  for (const bad of ["0", "-5", "1.5", "abc", " "]) assert.equal(load({ RATE_LIMIT_PER_MINUTE: bad }).rateLimitPerMinute, 100, bad);
  assert.equal(load({ TRUSTED_PROXY_HOPS: "2" }).trustedProxyHops, 2);
  assert.equal(load({ TRUSTED_PROXY_HOPS: "999" }).trustedProxyHops, 16);
  assert.equal(load({ TRUSTED_PROXY_HOPS: "x" }).trustedProxyHops, 1);
  assert.equal(load({ HAGEZI_ROTATION_SECONDS: "1" }).hageziRotationSeconds, 60);
  assert.equal(load({ HAGEZI_ROTATION_SECONDS: "999999" }).hageziRotationSeconds, 86_400);
  assert.equal(load({ HAGEZI_ROTATION_SECONDS: "abc" }).hageziRotationSeconds, 1_800);
  assert.equal(load({ HAGEZI_ROTATION_SECONDS: "" }).hageziRotationSeconds, 1_800);
  assert.equal(load({ HAGEZI_ROTATION_MODE: " Request " }).hageziRotationPerRequest, true);
});

test("HAGEZI_UPSTREAM_ENDPOINTS keeps only valid http(s) entries", () => {
  const loaded = config.loadConfig({
    HAGEZI_UPSTREAM_ENDPOINTS: " https://one.test/dns-query , not a url,, ftp://three.test/dns-query, http://two.test:8443/q ",
  });
  assert.deepEqual(loaded.hageziUpstreamEndpoints, ["https://one.test/dns-query", "http://two.test:8443/q"]);
});

test("the socket-IP preload uses the header and flag names config.ts expects", async () => {
  const preload = await readFile(new URL("../server/socket-ip-preload.cjs", import.meta.url), "utf8");
  assert.match(preload, new RegExp(`const HEADER = "${config.SOCKET_IP_HEADER}";`));
  assert.match(preload, new RegExp(`const FLAG = "${config.SOCKET_IP_PRELOAD_FLAG}";`));
});

test("getClientIp: trusted header first, the X-Forwarded-For entry TRUSTED_PROXY_HOPS from the right", () => {
  const get = (headers, identity = DEFAULT_IDENTITY) => clientIp.getClientIp(new Headers(headers), identity);
  assert.equal(get({ "x-forwarded-for": "6.6.6.6, 2.2.2.2" }), "2.2.2.2");
  assert.equal(get({ "x-forwarded-for": "2.2.2.2, " }), "2.2.2.2", "trailing empty entries are skipped");
  assert.equal(get({ "x-forwarded-for": "9.9.9.9, 2.2.2.2, 10.0.0.5" }, { ...DEFAULT_IDENTITY, trustedProxyHops: 2 }), "2.2.2.2");
  assert.equal(get({ "x-forwarded-for": "2.2.2.2" }, { ...DEFAULT_IDENTITY, trustedProxyHops: 2 }), undefined, "too few hops: no identity");
  assert.equal(get({ "x-forwarded-for": "2.2.2.2, junk" }), undefined, "an unusable entry never falls back to a client-written one");
  assert.equal(get({ "x-real-ip": "7.7.7.7", "x-forwarded-for": "2.2.2.2" }), "2.2.2.2", "X-Real-IP is ignored unless configured");
  const realIpFirst = { ...DEFAULT_IDENTITY, clientIpHeaders: ["x-real-ip", "x-forwarded-for"] };
  assert.equal(get({ "x-real-ip": "7.7.7.7", "x-forwarded-for": "2.2.2.2" }, realIpFirst), "7.7.7.7");
  assert.equal(get({ "x-real-ip": "bogus", "x-forwarded-for": "2.2.2.2" }, realIpFirst), "2.2.2.2", "a bad trusted header falls back to the next one");
});

test("getClientIp: the socket address is used when trust is off, and as the trusted-mode fallback, only with the preload", () => {
  const headers = new Headers({ "x-forwarded-for": "2.2.2.2", "x-doh-socket-ip": "::ffff:203.0.113.5" });
  const off = { ...DEFAULT_IDENTITY, trustProxyHeaders: false };
  assert.equal(clientIp.getClientIp(headers, off), undefined, "no preload: the socket header is ignored");
  globalThis.__dohSocketIpPreload = true;
  try {
    assert.equal(clientIp.getClientIp(headers, off), "203.0.113.5");
    assert.equal(clientIp.getClientIp(headers, DEFAULT_IDENTITY), "2.2.2.2");
    assert.equal(clientIp.getClientIp(new Headers({ "x-doh-socket-ip": "203.0.113.6" }), DEFAULT_IDENTITY), "203.0.113.6");
  } finally {
    delete globalThis.__dohSocketIpPreload;
  }
});

test("normalizeIp strips ports, brackets and zones, collapses IPv4-mapped IPv6 and keys IPv6 by /64", () => {
  const cases = new Map([
    ["1.2.3.4", "1.2.3.4"],
    ["1.2.3.4:8080", "1.2.3.4"],
    ["::ffff:1.2.3.4", "1.2.3.4"],
    ["[::ffff:1.2.3.4]:99", "1.2.3.4"],
    ["[2001:db8::1]:443", "2001:db8:0:0::/64"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"],
    ["::", "0:0:0:0::/64"],
    ["garbage", undefined],
    ["999.1.1.1", undefined],
    ["::::", undefined],
    ["   ", undefined],
  ]);
  for (const [raw, expected] of cases) assert.equal(clientIp.normalizeIp(raw), expected, JSON.stringify(raw));
});

test("doh.ts applies HAGEZI_UPSTREAM_ENDPOINTS without rotation", async () => {
  process.env.HAGEZI_UPSTREAM_ENDPOINTS = "https://one.test/dns-query?token=a, http://two.test:8443/q";
  process.env.HAGEZI_ROTATION_MODE = "request";
  try {
    const doh = await importDoh({ fresh: true });
    for (let i = 0; i < 4; i += 1) {
      assert.deepEqual(doh.getHageziUpstreams().map((upstream) => upstream.endpoint), ["https://one.test/dns-query?token=a", "http://two.test:8443/q"]);
    }
    assert.equal(doh.getHageziUpstreams()[0].getPrefix, "https://one.test/dns-query?token=a&");
  } finally {
    delete process.env.HAGEZI_UPSTREAM_ENDPOINTS;
    delete process.env.HAGEZI_ROTATION_MODE;
  }
});

test("doh.ts HAGEZI_ROTATION_MODE=request round-robins the primary resolver per request", async () => {
  process.env.HAGEZI_ROTATION_MODE = "request";
  try {
    const doh = await importDoh({ fresh: true });
    const firsts = Array.from({ length: 4 }, () => doh.getHageziUpstreams()[0].endpoint);
    assert.equal(new Set(firsts.slice(0, 3)).size, 3, "three consecutive requests start on three different resolvers");
    assert.equal(firsts[3], firsts[0], "the cycle repeats after one full round");
    assert.equal(new Set(doh.getHageziUpstreams().map((upstream) => upstream.endpoint)).size, 3);
  } finally {
    delete process.env.HAGEZI_ROTATION_MODE;
  }
});

test("doh.ts HAGEZI_ROTATION_SECONDS sets the time slot", async () => {
  process.env.HAGEZI_ROTATION_SECONDS = "60";
  const realNow = Date.now;
  try {
    const doh = await importDoh({ fresh: true });
    const firstAt = (now) => {
      Date.now = () => now;
      return doh.getHageziUpstreams()[0].endpoint;
    };
    const slot = 60_000 * 300;
    assert.equal(firstAt(slot), firstAt(slot + 59_000));
    assert.notEqual(firstAt(slot), firstAt(slot + 60_000));
  } finally {
    Date.now = realNow;
    delete process.env.HAGEZI_ROTATION_SECONDS;
  }
});

test("requests without a client key only count against the global in-flight ceiling", async () => {
  const doh = await importDoh();
  const originalFetch = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await gate;
    return dnsAnswer();
  };
  try {
    const dns = Buffer.from(validQuery()).toString("base64url");
    const options = { upstreams: [{ endpoint: "https://no-key.test/dns-query" }], timeoutMs: 2_000, failover: false };
    const count = doh.MAX_IN_FLIGHT_PER_IP + 1;
    const held = Array.from({ length: count }, () =>
      doh.proxyRequest(new Request(`https://proxy.test/api/doh/dns-query?dns=${dns}`), options),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, count);
    release();
    assert.ok((await Promise.all(held)).every((response) => response.status === 200));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
