/**
 * Environment-driven configuration (src/lib/config.ts) and client identity
 * (src/lib/client-ip.ts). Configuration is parsed once per module instance;
 * suites load fresh instances after changing process.env.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dnsAnswer, validQuery } from "./lib/dns-fixtures.mjs";
import { importDoh, importSource } from "./lib/transpile-source.mjs";

const config = await importSource("lib/config.ts");
const clientIp = await importSource("lib/client-ip.ts");

const DEFAULT_IDENTITY = {
  trustProxyHeaders: true,
  clientIpHeaders: ["x-forwarded-for"],
  trustedProxyHops: 1,
  trustedProxies: ["loopback", "private"],
};

test("defaults: trust on (loopback/private peers), 100/min, self-hosted X-Forwarded-For, per-client rotation", () => {
  const loaded = config.loadConfig({});
  assert.equal(loaded.trustProxyHeaders, true);
  assert.equal(loaded.rateLimitPerMinute, 100);
  assert.equal(loaded.platform, "self-hosted");
  assert.deepEqual(loaded.clientIpHeaders, ["x-forwarded-for"]);
  assert.equal(loaded.trustedProxyHops, 1);
  assert.deepEqual(loaded.trustedProxies, ["loopback", "private"]);
  assert.equal(loaded.hageziRotationSeconds, 1_800);
  assert.equal(loaded.hageziRotationMode, "client");
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
  // DOH_BUILD_PLATFORM is always inlined by next.config.ts; the runtime
  // VERCEL/NETLIFY markers are not consulted.
  assert.equal(config.loadConfig({ VERCEL: "1" }).platform, "self-hosted");
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
  assert.equal(load({ HAGEZI_ROTATION_MODE: " Request " }).hageziRotationMode, "request");
  assert.equal(load({ HAGEZI_ROTATION_MODE: "TIME" }).hageziRotationMode, "time");
  assert.equal(load({ HAGEZI_ROTATION_MODE: "bogus" }).hageziRotationMode, "client");
  assert.deepEqual(load({ TRUSTED_PROXIES: " 10.1.0.0/16 , LOOPBACK " }).trustedProxies, ["10.1.0.0/16", "loopback"]);
  assert.deepEqual(load({ TRUSTED_PROXIES: " " }).trustedProxies, ["loopback", "private"]);
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
  const headers = new Headers({ "x-forwarded-for": "2.2.2.2", "x-doh-socket-ip": "::ffff:10.0.0.5" });
  const off = { ...DEFAULT_IDENTITY, trustProxyHeaders: false };
  assert.equal(clientIp.getClientIp(headers, off), undefined, "no preload: the socket header is ignored");
  assert.equal(clientIp.getClientIp(headers, DEFAULT_IDENTITY), "2.2.2.2", "no preload (managed platform): the header is trusted");
  globalThis.__dohSocketIpPreload = true;
  try {
    assert.equal(clientIp.getClientIp(headers, off), "10.0.0.5");
    assert.equal(clientIp.getClientIp(headers, DEFAULT_IDENTITY), "2.2.2.2", "private peer = trusted proxy");
    assert.equal(clientIp.getClientIp(new Headers({ "x-doh-socket-ip": "10.0.0.6" }), DEFAULT_IDENTITY), "10.0.0.6");
  } finally {
    delete globalThis.__dohSocketIpPreload;
  }
});

test("TRUSTED_PROXIES: forwarding headers from a peer outside the list are ignored", () => {
  globalThis.__dohSocketIpPreload = true;
  try {
    const get = (peer, trustedProxies = DEFAULT_IDENTITY.trustedProxies, xff = "6.6.6.6") =>
      clientIp.getClientIp(new Headers({ "x-forwarded-for": xff, "x-doh-socket-ip": peer }), { ...DEFAULT_IDENTITY, trustedProxies });
    // A directly connected internet client cannot mint identities.
    assert.equal(get("203.0.113.9"), "203.0.113.9");
    assert.equal(get("::ffff:203.0.113.9"), "203.0.113.9");
    assert.equal(get("2001:db8:1:2::7"), "2001:db8:1:2::/64");
    // Default ranges: loopback and private (RFC 1918 / RFC 4193).
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.1", "fd00::1"]) {
      assert.equal(get(peer), "6.6.6.6", peer);
    }
    assert.equal(get("172.32.0.1"), "172.32.0.1", "outside 172.16.0.0/12");
    assert.equal(get("169.254.1.1"), "169.254.1.1", "link-local is opt-in");
    assert.equal(get("169.254.1.1", ["linklocal"]), "6.6.6.6");
    // Explicit IPs/CIDRs, `*` and `none`.
    assert.equal(get("203.0.113.9", ["203.0.113.0/24"]), "6.6.6.6");
    assert.equal(get("203.0.113.9", ["203.0.113.9"]), "6.6.6.6");
    assert.equal(get("2001:db8::5", ["2001:db8::/32"]), "6.6.6.6");
    assert.equal(get("203.0.113.9", ["*"]), "6.6.6.6", "* trusts every peer (pre-2.10 behavior)");
    assert.equal(get("127.0.0.1", ["none"]), "127.0.0.1");
    assert.equal(get("127.0.0.1", ["not-an-ip", "10.0.0.0/99"]), "127.0.0.1", "invalid entries are ignored");
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

test("NEXT_PUBLIC_SITE_URL: scheme is case-insensitive, a bare host gets https, other schemes are ignored", async () => {
  const keys = ["NEXT_PUBLIC_SITE_URL", "CONTEXT", "URL", "DEPLOY_PRIME_URL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const siteUrl = async (value) => {
    for (const key of keys) delete process.env[key];
    if (value !== undefined) process.env.NEXT_PUBLIC_SITE_URL = value;
    return (await importSource("lib/site.ts", { fresh: true })).SITE_URL;
  };
  try {
    assert.equal(await siteUrl("https://dns.example.com/some/path?x=1"), "https://dns.example.com", "path and query are dropped");
    assert.equal(await siteUrl("HTTPS://DNS.Example.com"), "https://dns.example.com", "mixed-case scheme (was mangled into https://https)");
    assert.equal(await siteUrl("Http://localhost:8367"), "http://localhost:8367");
    assert.equal(await siteUrl("dns.example.com"), "https://dns.example.com", "bare host");
    assert.equal(await siteUrl("localhost:3000"), "https://localhost:3000", "host:port is not mistaken for a scheme");
    assert.equal(await siteUrl("ftp://dns.example.com"), "http://localhost:3000", "non-http(s) scheme is ignored, not rewritten");
    assert.equal(await siteUrl("   "), "http://localhost:3000", "blank value falls through to the default");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
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

test("doh.ts default client rotation: stable per client key, spread across resolvers", async () => {
  delete process.env.HAGEZI_ROTATION_MODE;
  const doh = await importDoh({ fresh: true });
  const first = (key) => doh.getHageziUpstreams(key)[0].endpoint;
  for (const key of ["203.0.113.1", "2001:db8:1:2::/64"]) assert.equal(first(key), first(key), "stable for one client");
  const firsts = new Set(Array.from({ length: 64 }, (_, i) => first(`198.51.100.${i}`)));
  assert.equal(firsts.size, 3, "different clients start on every resolver");
  const keyless = new Set(Array.from({ length: 3 }, () => first(null)));
  assert.equal(keyless.size, 3, "requests without a client key round-robin");
});

test("doh.ts HAGEZI_ROTATION_SECONDS sets the time slot", async () => {
  process.env.HAGEZI_ROTATION_SECONDS = "60";
  process.env.HAGEZI_ROTATION_MODE = "time";
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
    delete process.env.HAGEZI_ROTATION_MODE;
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

test("next.config.ts caps the buffered request body one byte above MAX_DNS_MESSAGE_SIZE", async () => {
  const dns = await importSource("lib/dns.ts");
  const nextConfig = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  const cap = Number(/proxyClientMaxBodySize: ([\d_]+)/.exec(nextConfig)?.[1].replaceAll("_", ""));
  assert.equal(cap, dns.MAX_DNS_MESSAGE_SIZE + 1);
  const preload = await readFile(new URL("../server/socket-ip-preload.cjs", import.meta.url), "utf8");
  const split = Number(/const BODY_CAP_BYTES = ([\d_]+)/.exec(preload)?.[1].replaceAll("_", ""));
  assert.equal(split, cap, "the preload splits body chunks at the same cap");
});

test("the preload gives http.createServer() tight request/header timeouts; explicit options win", () => {
  // fileURLToPath, not URL#pathname: the latter keeps percent-encoding (spaces) and breaks on Windows.
  const preload = fileURLToPath(new URL("../server/socket-ip-preload.cjs", import.meta.url));
  const script = `
    const http = require("node:http");
    const a = http.createServer(() => {});
    const b = http.createServer({ requestTimeout: 1234 }, () => {});
    process.stdout.write(JSON.stringify([a.requestTimeout, a.headersTimeout, b.requestTimeout, b.headersTimeout, globalThis.__dohSocketIpPreload]));
  `;
  const output = execFileSync(process.execPath, ["--require", preload, "-e", script], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), [10_000, 5_000, 1234, 1234, true], "headersTimeout is clamped to a shorter requestTimeout");
});
