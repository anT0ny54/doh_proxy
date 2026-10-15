/**
 * End-to-end integration tests. Launches the PRODUCTION build with
 * `next start` (plus server/socket-ip-preload.cjs, exactly like `npm start`)
 * against a local mock DoH upstream and exercises real HTTP: GET/POST,
 * invalid content types, oversized bodies, slow clients, upstream failures,
 * response headers, routing and the per-client rate limit in both
 * TRUST_PROXY_HEADERS modes. (Processes are only terminated in teardown;
 * graceful shutdown itself is not asserted.)
 *
 * Requires `npm run build` first (CI runs build before this script).
 * Hermetic via HAGEZI_UPSTREAM_ENDPOINTS (see src/lib/config.ts).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DNS_MESSAGE, validQuery } from "./lib/dns-fixtures.mjs";
import { startMockUpstream } from "./lib/mock-upstream.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Raw GET via node:http so the source address and headers are fully controlled. */
function rawGet(base, path, { headers = {}, localAddress } = {}) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers, localAddress, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function startApp(env) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["--require", "./server/socket-ip-preload.cjs", "node_modules/next/dist/bin/next", "start", "-p", String(port)],
    {
      env: { ...process.env, HOSTNAME: "127.0.0.1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));

  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited early (${child.exitCode})\n${logs}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return { child, base: `http://127.0.0.1:${port}` };
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  child.kill("SIGKILL");
  throw new Error(`app did not become ready: ${lastError}\n${logs}`);
}

async function stopApp(app) {
  if (!app) return;
  app.child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => app.child.once("exit", () => resolve(true))),
    delay(10_000).then(() => false),
  ]);
  if (!exited) app.child.kill("SIGKILL");
}

const VALID_QUERY = Buffer.from(validQuery());
const VALID_QUERY_B64 = VALID_QUERY.toString("base64url");

const LIMIT = 3;
const DOH_PATH = `/api/doh/dns-query?dns=${VALID_QUERY_B64}`;

let mock;
let app;
let failingApp;
let trustedApp;
let untrustedApp;

before(async () => {
  assert.ok(existsSync(".next/BUILD_ID"), "run `npm run build` before the integration tests");
  mock = await startMockUpstream();
  const upstream = { HAGEZI_UPSTREAM_ENDPOINTS: `http://127.0.0.1:${mock.address().port}/dns-query` };
  // Upstream that refuses connections, to exercise the failure path.
  const deadPort = await freePort();
  [app, failingApp, trustedApp, untrustedApp] = await Promise.all([
    startApp(upstream),
    startApp({ HAGEZI_UPSTREAM_ENDPOINTS: `http://127.0.0.1:${deadPort}/dns-query` }),
    startApp({ ...upstream, TRUST_PROXY_HEADERS: "1", RATE_LIMIT_PER_MINUTE: String(LIMIT) }),
    startApp({ ...upstream, TRUST_PROXY_HEADERS: "0", RATE_LIMIT_PER_MINUTE: String(LIMIT) }),
  ]);
});

after(async () => {
  await Promise.all([stopApp(untrustedApp), stopApp(trustedApp), stopApp(failingApp), stopApp(app)]);
  // Guarded: when setup fails before the mock exists (e.g. missing BUILD_ID),
  // an unconditional mock?.close(resolve) would never settle and hang teardown.
  if (mock) await new Promise((resolve) => mock.close(resolve));
});

test("GET with a valid dns parameter proxies a matching response", async () => {
  const res = await fetch(`${app.base}/api/doh/dns-query?dns=${VALID_QUERY_B64}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), DNS_MESSAGE);
  assert.match(res.headers.get("cache-control") ?? "", /max-age=120/); // upstream max-age relayed for GET
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(Number(res.headers.get("content-length")), body.length, "Content-Length is set by the server");
  assert.equal(body.length > 12, true);
  assert.equal((body[0] << 8) | body[1], 0x1234); // transaction ID preserved
  assert.equal(body[2] & 0x80, 0x80); // QR bit set
});

test("GET with a malformed or missing dns parameter is rejected", async () => {
  const bad = await fetch(`${app.base}/api/doh/dns-query?dns=not!base64!`);
  assert.equal(bad.status, 400);
  const missing = await fetch(`${app.base}/api/doh/dns-query`);
  assert.equal(missing.status, 400);
});

test("POST with a valid body proxies a matching response", async () => {
  const res = await fetch(`${app.base}/api/doh/dns-query`, {
    method: "POST",
    headers: { "content-type": DNS_MESSAGE },
    body: VALID_QUERY,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), DNS_MESSAGE);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal((body[0] << 8) | body[1], 0x1234);
});

test("POST with a wrong content type gets 415", async () => {
  const res = await fetch(`${app.base}/api/doh/dns-query`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hello",
  });
  assert.equal(res.status, 415);
});

test("POST body exceeding the size cap mid-stream gets 413", async () => {
  // Stream more than MAX_DNS_MESSAGE_SIZE with chunked encoding so the
  // server's own size cap (not a client-side content-length mismatch)
  // terminates the request partway through the upload.
  const res = await fetch(`${app.base}/api/doh/dns-query`, {
    method: "POST",
    headers: { "content-type": DNS_MESSAGE },
    duplex: "half",
    body: (async function* () {
      const chunk = Buffer.alloc(1024);
      for (let i = 0; i < 5; i += 1) yield chunk; // 5120 bytes > 4096 cap
    })(),
  });
  assert.equal(res.status, 413);
});

test("OPTIONS/HEAD get a CORS-enabled 204; other methods get 405", async () => {
  const options = await fetch(`${app.base}/api/doh/dns-query`, { method: "OPTIONS" });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "*");

  const head = await fetch(`${app.base}/api/doh/dns-query`, { method: "HEAD" });
  assert.equal(head.status, 204);

  const put = await fetch(`${app.base}/api/doh/dns-query`, {
    method: "PUT",
    headers: { "content-type": DNS_MESSAGE },
    body: VALID_QUERY,
  });
  // PUT is not exported by the route, so Next's router answers 405 itself.
  assert.equal(put.status, 405);
});

test("a slow client uploading a POST body gets a bounded terminal response", async () => {
  const port = Number(new URL(app.base).port);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/doh/dns-query", method: "POST", headers: { "content-type": DNS_MESSAGE } },
      (res) => resolve(res.statusCode),
    );
    req.on("error", reject);
    // Trickles a VALID query for well over MAX_BODY_READ_MS (1s). With proxy.ts
    // in the pipeline Next.js buffers the request body before the route runs,
    // so the body-read deadline applies post-buffering: a streaming-enforced
    // server answers 408, a buffering one proxies the completed query (200).
    // The 408 path itself is unit-tested with synthetic slow bodies.
    let offset = 0;
    const timer = setInterval(() => {
      const end = Math.min(offset + 4, VALID_QUERY.length);
      req.write(VALID_QUERY.subarray(offset, end));
      offset = end;
      if (offset >= VALID_QUERY.length) {
        clearInterval(timer);
        req.end();
      }
    }, 400);
  });
  assert.ok([200, 408].includes(status), `expected 200 or 408, got ${status}`);
});

test("unreachable upstream surfaces a generic 502", async () => {
  const res = await fetch(`${failingApp.base}/api/doh/dns-query?dns=${VALID_QUERY_B64}`);
  assert.equal(res.status, 502);
});

test("unknown provider ids get 404 from the router", async () => {
  const res = await fetch(`${app.base}/api/doh/not-a-provider/dns-query?dns=${VALID_QUERY_B64}`);
  assert.equal(res.status, 404);
});

test("TRUST_PROXY_HEADERS=1: the limit applies per X-Forwarded-For client", async () => {
  for (let i = 0; i < LIMIT; i += 1) {
    assert.equal(await rawGet(trustedApp.base, DOH_PATH, { headers: { "x-forwarded-for": "203.0.113.1" } }), 200);
  }
  assert.equal(await rawGet(trustedApp.base, DOH_PATH, { headers: { "x-forwarded-for": "203.0.113.1" } }), 429);
  assert.equal(await rawGet(trustedApp.base, DOH_PATH, { headers: { "x-forwarded-for": "203.0.113.2" } }), 200);
});

test("TRUST_PROXY_HEADERS=0: the limit applies per socket address and forged headers do not help", async () => {
  for (let i = 0; i < LIMIT; i += 1) {
    const headers = { "x-forwarded-for": `198.51.100.${i}`, "x-real-ip": `192.0.2.${i}`, "x-doh-socket-ip": `10.9.9.${i}` };
    assert.equal(await rawGet(untrustedApp.base, DOH_PATH, { headers, localAddress: "127.0.0.1" }), 200);
  }
  const forged = { "x-forwarded-for": "198.51.100.200", "x-doh-socket-ip": "10.9.9.200" };
  assert.equal(await rawGet(untrustedApp.base, DOH_PATH, { headers: forged, localAddress: "127.0.0.1" }), 429);
  assert.equal(await rawGet(untrustedApp.base, DOH_PATH, { localAddress: "127.0.0.2" }), 200, "another source address has its own bucket");
});

test("a 429 carries Retry-After and CORS headers; preflights are never limited", async () => {
  const headers = { "x-forwarded-for": "203.0.113.1" };
  const limited = await fetch(`${trustedApp.base}${DOH_PATH}`, { headers });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(limited.headers.get("access-control-allow-origin"), "*");
  const preflight = await fetch(`${trustedApp.base}/api/doh/dns-query`, { method: "OPTIONS", headers });
  assert.equal(preflight.status, 204);
});
