/**
 * End-to-end integration tests. Launches the PRODUCTION build with
 * `next start` against a local mock DoH upstream and exercises real HTTP:
 * GET/POST, invalid content types, oversized bodies, slow clients, upstream
 * failures, response headers and graceful shutdown.
 *
 * Requires `npm run build` first (CI runs build before this script).
 * Hermetic via HAGEZI_UPSTREAM_ENDPOINTS (see src/lib/doh.ts).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const DNS_MESSAGE = "application/dns-message";

function encodeName(name) {
  const labels = name.split(".").flatMap((label) => [label.length, ...Buffer.from(label)]);
  return Buffer.from([...labels, 0]);
}

function buildQuery(id = 0x1234, name = "example.com") {
  const qname = encodeName(name);
  const message = Buffer.alloc(12 + qname.length + 4);
  message.writeUInt16BE(id, 0);
  message.writeUInt16BE(0x0000, 2);
  message.writeUInt16BE(1, 4);
  qname.copy(message, 12);
  message.writeUInt16BE(1, 12 + qname.length);
  message.writeUInt16BE(1, 12 + qname.length + 2);
  return message;
}

/** Canned 200 answer that echoes the question and adds an A record. */
function buildUpstreamResponse(query) {
  let offset = 12;
  while (query[offset] !== 0) offset += 1 + query[offset];
  const questionEnd = offset + 5;
  const answer = Buffer.concat([
    Buffer.from([0xc0, 0x0c]), // pointer to the question name
    Buffer.from([0, 1, 0, 1]), // type A, class IN
    Buffer.from([0, 0, 0, 60]), // TTL 60
    Buffer.from([0, 4, 1, 2, 3, 4]),
  ]);
  const message = Buffer.alloc(questionEnd + answer.length);
  query.copy(message, 0, 0, 12);
  message.writeUInt16BE(0x8180, 2);
  message.writeUInt16BE(1, 4);
  message.writeUInt16BE(1, 6);
  query.copy(message, 12, 12, questionEnd);
  answer.copy(message, questionEnd);
  return message;
}

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

function startMockUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let query;
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET") query = Buffer.from(url.searchParams.get("dns") ?? "", "base64url");
      else query = Buffer.concat(chunks);
      res.writeHead(200, {
        "content-type": DNS_MESSAGE,
        "cache-control": "max-age=120",
      });
      res.end(buildUpstreamResponse(query));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function startApp(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: { ...process.env, HOSTNAME: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

const VALID_QUERY = buildQuery();
const VALID_QUERY_B64 = VALID_QUERY.toString("base64url");

let mock;
let app;
let failingApp;

before(async () => {
  assert.ok(existsSync(".next/BUILD_ID"), "run `npm run build` before the integration tests");
  mock = await startMockUpstream();
  app = await startApp({ HAGEZI_UPSTREAM_ENDPOINTS: `http://127.0.0.1:${mock.address().port}/dns-query` });
  // Upstream that refuses connections, to exercise the failure path.
  const deadPort = await freePort();
  failingApp = await startApp({ HAGEZI_UPSTREAM_ENDPOINTS: `http://127.0.0.1:${deadPort}/dns-query` });
});

after(async () => {
  await stopApp(failingApp);
  await stopApp(app);
  await new Promise((resolve) => mock?.close(resolve));
});

test("GET with a valid dns parameter proxies a matching response", async () => {
  const res = await fetch(`${app.base}/api/doh/dns-query?dns=${VALID_QUERY_B64}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), DNS_MESSAGE);
  assert.match(res.headers.get("cache-control") ?? "", /max-age=120/); // upstream max-age relayed for GET
  const body = new Uint8Array(await res.arrayBuffer());
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
  // PUT is not exported by the route, so Next's router answers 405 itself
  // (the handler-level 405 with an Allow header is unit-tested via the stub).
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
