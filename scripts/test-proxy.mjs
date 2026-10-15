import { test } from "node:test";
import assert from "node:assert/strict";
import { importSource } from "./lib/transpile-source.mjs";

delete process.env.RATE_LIMIT_PER_MINUTE;
delete process.env.CLIENT_IP_HEADERS;
delete process.env.TRUSTED_PROXY_HOPS;
delete process.env.TRUSTED_PROXIES;

const SOCKET_HEADER = "x-doh-socket-ip";
const KEY_HEADER = "x-doh-client-key";
const LIMIT = 100;

async function loadProxy(trust) {
  process.env.TRUST_PROXY_HEADERS = trust;
  return (await importSource("proxy.ts", { fresh: true })).default;
}

function request(headers, method = "GET") {
  return { method, headers: new Headers(headers) };
}

// Simulate server/socket-ip-preload.cjs being loaded in this process.
globalThis.__dohSocketIpPreload = true;

test("TRUST_PROXY_HEADERS=1: 100/min per X-Forwarded-For client; the key is handed to the route", async () => {
  const proxy = await loadProxy("1");
  for (let i = 0; i < LIMIT; i += 1) {
    const response = proxy(request({ "x-forwarded-for": "203.0.113.10", [SOCKET_HEADER]: "10.0.0.1" }));
    assert.equal(response.status, 200);
    assert.equal(response.requestHeaders.get(KEY_HEADER), "203.0.113.10");
  }
  const limited = proxy(request({ "x-forwarded-for": "203.0.113.10" }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("access-control-allow-methods"), "GET, POST, HEAD, OPTIONS");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(proxy(request({ "x-forwarded-for": "203.0.113.11" })).status, 200, "other clients are unaffected");
});

test("TRUST_PROXY_HEADERS=0: 100/min per socket address; forged headers are ignored", async () => {
  const proxy = await loadProxy("0");
  for (let i = 0; i < LIMIT; i += 1) {
    const forged = { "x-forwarded-for": `198.51.100.${i % 250}`, "x-real-ip": `192.0.2.${i % 250}`, [SOCKET_HEADER]: "203.0.113.20" };
    const response = proxy(request(forged));
    assert.equal(response.status, 200);
    assert.equal(response.requestHeaders.get(KEY_HEADER), "203.0.113.20");
  }
  assert.equal(proxy(request({ "x-forwarded-for": "1.1.1.1", [SOCKET_HEADER]: "203.0.113.20" })).status, 429);
  assert.equal(proxy(request({ [SOCKET_HEADER]: "203.0.113.21" })).status, 200, "a different socket address has its own bucket");
});

test("ports, IPv4-mapped IPv6 and IPv6 /64s collapse into one key", async () => {
  const proxy = await loadProxy("1");
  const ips = ["198.51.100.7:1111", "198.51.100.7:2222", "::ffff:198.51.100.7", "[::ffff:198.51.100.7]:99"];
  for (let i = 0; i < LIMIT; i += 1) proxy(request({ "x-forwarded-for": ips[i % ips.length] }));
  assert.equal(proxy(request({ "x-forwarded-for": "198.51.100.7" })).status, 429);

  for (let i = 0; i < LIMIT; i += 1) proxy(request({ "x-forwarded-for": `2001:db8:1:2:${i.toString(16)}::1` }));
  assert.equal(proxy(request({ "x-forwarded-for": "2001:db8:1:2:ffff::9" })).status, 429);
});

test("an injected client key is removed when no address is known", async () => {
  const saved = globalThis.__dohSocketIpPreload;
  delete globalThis.__dohSocketIpPreload;
  try {
    const proxy = await loadProxy("0");
    const response = proxy(request({ [KEY_HEADER]: "forged", [SOCKET_HEADER]: "203.0.113.30" }));
    assert.equal(response.status, 200);
    assert.equal(response.requestHeaders.has(KEY_HEADER), false, "without the preload the socket header is ignored too");
  } finally {
    globalThis.__dohSocketIpPreload = saved;
  }
});

test("CORS preflights and HEAD health checks are not rate limited", async () => {
  const proxy = await loadProxy("1");
  for (const method of ["OPTIONS", "HEAD"]) {
    for (let i = 0; i < LIMIT + 5; i += 1) {
      assert.equal(proxy(request({ "x-forwarded-for": "203.0.113.40" }, method)).status, 200, method);
    }
  }
  assert.equal(proxy(request({ "x-forwarded-for": "203.0.113.40" })).status, 200, "GET budget untouched");
});

test("TRUST_PROXY_HEADERS=1: a directly connected client cannot bypass the limit by rotating X-Forwarded-For", async () => {
  const proxy = await loadProxy("1");
  for (let i = 0; i < LIMIT; i += 1) {
    const response = proxy(request({ "x-forwarded-for": `198.51.100.${i % 250}`, [SOCKET_HEADER]: "203.0.113.50" }));
    assert.equal(response.status, 200);
    assert.equal(response.requestHeaders.get(KEY_HEADER), "203.0.113.50", "public peer: its own address is the key");
  }
  assert.equal(proxy(request({ "x-forwarded-for": "198.51.100.251", [SOCKET_HEADER]: "203.0.113.50" })).status, 429);
});

test("the limiter runs on a monotonic clock: a wall-clock step neither resets nor freezes it", async () => {
  const proxy = await loadProxy("1");
  const wallNow = Date.now;
  const monotonicNow = performance.now;
  let monotonic = monotonicNow.call(performance);
  performance.now = () => monotonic;
  const headers = { "x-forwarded-for": "203.0.113.90" };
  try {
    for (let i = 0; i < LIMIT; i += 1) assert.equal(proxy(request(headers)).status, 200);
    assert.equal(proxy(request(headers)).status, 429);

    // An NTP step in either direction must not change the verdict...
    Date.now = () => wallNow() + 2 * 3_600_000;
    assert.equal(proxy(request(headers)).status, 429, "forward step does not reset the budget");
    Date.now = () => wallNow() - 2 * 3_600_000;
    assert.equal(proxy(request(headers)).status, 429, "backward step does not reset the budget");

    // ...and real elapsed time still frees it, whatever the wall clock says.
    monotonic += 120_000;
    assert.equal(proxy(request(headers)).status, 200, "two real windows later the budget is back");
  } finally {
    Date.now = wallNow;
    performance.now = monotonicNow;
  }
});
