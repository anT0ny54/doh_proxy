import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { importDoh } from "./lib/transpile-source.mjs";

// The suite drives per-IP in-flight limits through x-real-ip headers, so opt
// in to trusting forwarding headers (client-ip.ts ignores them otherwise).
process.env.TRUST_PROXY_HEADERS = "1";

const doh = await importDoh();

function validQuery(id = 0x1234) {
  return Uint8Array.from([
    id >>> 8,
    id & 0xff,
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
  const question = query.slice(12);
  return Uint8Array.from([
    query[0], query[1],
    0x81, 0x80,
    0x00, 0x01,
    0x00, 0x01,
    0x00, 0x00,
    0x00, 0x00,
    ...question,
    0xc0, 0x0c,
    0x00, 0x01,
    0x00, 0x01,
    0x00, 0x00, 0x00, 0x3c,
    0x00, 0x04, 1, 2, 3, 4,
  ]);
}

function getRequest(query = validQuery()) {
  const dns = Buffer.from(query).toString("base64url");
  return new Request(`https://proxy.test/api/doh/dns-query?dns=${dns}`, { method: "GET" });
}

function postRequest(body = validQuery()) {
  return {
    method: "POST",
    url: "https://proxy.test/api/doh/dns-query",
    headers: new Headers({ "content-type": "application/dns-message" }),
    body,
  };
}

function getLikeRequest(method, url = "https://proxy.test/api/doh/dns-query") {
  return { method, url, headers: new Headers(), body: null };
}

const originalFetch = globalThis.fetch;

try {
  await test("DoH GET accepts a valid DNS message", async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return new Response(validResponse(), {
        status: 200,
        headers: { "content-type": "application/dns-message" },
      });
    };

    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://upstream.test/dns-query" }],
      timeoutMs: 100,
      failover: false,
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /upstream\.test/);
  });

  await test("DoH upstream redirects are rejected", async () => {
    let redirectMode;
    globalThis.fetch = async (_url, init) => {
      redirectMode = init.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.test/dns-query" },
      });
    };

    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://redirect.test/dns-query" }],
      timeoutMs: 100,
      failover: false,
    });

    assert.equal(redirectMode, "error");
    assert.equal(response.status, 502);
  });

  await test("DoH failover retries a retryable upstream status", async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response(null, { status: 503 });
      return new Response(validResponse(), {
        status: 200,
        headers: { "content-type": "application/dns-message" },
      });
    };

    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [
        { endpoint: "https://first.test/dns-query" },
        { endpoint: "https://second.test/dns-query" },
      ],
      timeoutMs: 100,
      failover: true,
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /first\.test/);
    assert.match(calls[1], /second\.test/);
  });

  await test("DoH returns 502 after an upstream timeout", async () => {
    let calls = 0;
    globalThis.fetch = (_url, init) => {
      calls += 1;
      return new Promise((_, reject) => {
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        init.signal.addEventListener("abort", onAbort, { once: true });
      });
    };

    const started = Date.now();
    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://timeout.test/dns-query" }],
      timeoutMs: 40,
      failover: false,
    });

    assert.equal(response.status, 502);
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 500, "timeout path should stay bounded");
  });

  await test("DoH POST body cancellation is bounded", async () => {
    const pendingBody = {
      getReader() {
        return {
          read() {
            return new Promise(() => {});
          },
          cancel() {
            return new Promise(() => {});
          },
          releaseLock() {},
        };
      },
    };

    globalThis.fetch = async () => {
      throw new Error("fetch must not run after a body timeout");
    };

    const started = Date.now();
    const response = await doh.proxyRequest(postRequest(pendingBody), {
      upstreams: [{ endpoint: "https://never-reached.test/dns-query" }],
      timeoutMs: 40,
      failover: false,
    });

    assert.equal(response.status, 408);
    assert.ok(Date.now() - started < 400, "body cancellation must not extend the deadline indefinitely");
  });

  await test("HEAD and OPTIONS return before any upstream fetch", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("fetch must not run for HEAD/OPTIONS");
    };

    const originalNow = Date.now;
    let nowCalls = 0;
    Date.now = () => {
      nowCalls += 1;
      return originalNow();
    };

    try {
      const head = await doh.handleHageziDoH(getLikeRequest("HEAD"));
      const options = await doh.handleHageziDoH(getLikeRequest("OPTIONS"));

      assert.equal(head.status, 204);
      assert.equal(options.status, 204);
      assert.equal(calls, 0);
      assert.equal(nowCalls, 0, "HEAD/OPTIONS must return before HaGeZi rotation reads the clock");
    } finally {
      Date.now = originalNow;
    }
  });

  await test("Non-retryable upstream status is returned directly without failover", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 403 });
    };

    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://only.test/dns-query" }],
      timeoutMs: 100,
      failover: false,
    });

    assert.equal(response.status, 403);
    assert.equal(calls, 1);
  });

  await test("Failover continues past a non-retryable status and relays it only if nothing answers", async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes("blocked.test")) return new Response(null, { status: 403 });
      return new Response(validResponse(), { status: 200, headers: { "content-type": "application/dns-message" } });
    };

    const recovered = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://blocked.test/dns-query" }, { endpoint: "https://good.test/dns-query" }],
      timeoutMs: 100,
      failover: true,
    });
    assert.equal(recovered.status, 200);
    assert.equal(seen.length, 2);

    seen.length = 0;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response(null, { status: 403 });
    };
    const rejected = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://all-403-a.test/dns-query" }, { endpoint: "https://all-403-b.test/dns-query" }],
      timeoutMs: 100,
      failover: true,
    });
    assert.equal(rejected.status, 403);
    assert.equal(seen.length, 2);
  });

  await test("Upstream responses larger than 4 KiB (DNSSEC/TXT) are relayed", async () => {
    const query = validQuery();
    const question = query.slice(12);
    const records = [];
    for (let i = 0; i < 17; i += 1) {
      const rdata = [255, ...new Uint8Array(255).fill(97)];
      records.push(0xc0, 0x0c, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, rdata.length >> 8, rdata.length & 0xff, ...rdata);
    }
    const big = Uint8Array.from([query[0], query[1], 0x81, 0x80, 0, 1, 0, 17, 0, 0, 0, 0, ...question, ...records]);
    assert.ok(big.byteLength > 4_096);

    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(big, { status: 200, headers: { "content-type": "application/dns-message" } });
    };
    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://big.test/dns-query" }, { endpoint: "https://big2.test/dns-query" }],
      timeoutMs: 100,
      failover: true,
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.equal((await response.arrayBuffer()).byteLength, big.byteLength);
  });

  await test("A slow POST body that leaves no upstream budget neither fetches nor trips the breaker", async () => {
    const query = validQuery();
    const slowBody = {
      getReader() {
        let step = 0;
        return {
          read() {
            step += 1;
            if (step === 1) {
              // Leaves ~50 ms of the 250 ms minimum deadline for the upstream.
              return new Promise((resolve) => setTimeout(() => resolve({ done: false, value: query }), 200));
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          cancel() {
            return Promise.resolve();
          },
          releaseLock() {},
        };
      },
    };

    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(validResponse(query), { status: 200, headers: { "content-type": "application/dns-message" } });
    };
    const options = { upstreams: [{ endpoint: "https://slow-client.test/dns-query" }], timeoutMs: 250, failover: false };

    for (let i = 0; i < 4; i += 1) {
      const slow = await doh.proxyRequest(postRequest(slowBody), options);
      assert.equal(slow.status, 502);
    }
    assert.equal(calls, 0, "no upstream attempt should be made with a sub-100 ms budget");

    // A normal follow-up request must still be served normally.
    const ok = await doh.proxyRequest(getRequest(query), options);
    assert.equal(ok.status, 200);
    assert.equal(calls, 1);
  });

  await test("Client-influenced failures never open the circuit breaker", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 400 });
    };

    const options = { upstreams: [{ endpoint: "https://reject-400.test/dns-query" }], timeoutMs: 100, failover: false };
    for (let i = 0; i < 5; i += 1) {
      const response = await doh.proxyRequest(getRequest(), options);
      assert.equal(response.status, 400);
    }
    assert.equal(calls, 5, "every request must still reach the upstream");
  });

  await test("Open circuit breaker is bypassed when every upstream is open", async () => {
    let calls = 0;
    let healthy = false;
    globalThis.fetch = async () => {
      calls += 1;
      if (!healthy) return new Response(null, { status: 503 });
      return new Response(validResponse(), { status: 200, headers: { "content-type": "application/dns-message" } });
    };

    const options = { upstreams: [{ endpoint: "https://flaky.test/dns-query" }], timeoutMs: 100, failover: false };
    for (let i = 0; i < 3; i += 1) assert.equal((await doh.proxyRequest(getRequest(), options)).status, 502);

    healthy = true;
    const probe = await doh.proxyRequest(getRequest(), options);
    assert.equal(probe.status, 200, "sole upstream must still be probed while its breaker is open");
    assert.equal(calls, 4);
  });

  await test("Lazy upstream resolver is not invoked for HEAD/OPTIONS or invalid queries", async () => {
    let resolved = 0;
    const options = { upstreams: () => { resolved += 1; return [{ endpoint: "https://lazy.test/dns-query" }]; } };
    await doh.proxyRequest(getLikeRequest("HEAD"), options);
    await doh.proxyRequest(getLikeRequest("OPTIONS"), options);
    const bad = await doh.proxyRequest(new Request("https://proxy.test/api/doh/dns-query?dns=!!!"), options);
    assert.equal(bad.status, 400);
    assert.equal(resolved, 0);
  });

  await test("HaGeZi upstream set is pre-parsed and rotated", () => {
    const hageziUpstreams = doh.getHageziUpstreams();
    assert.equal(hageziUpstreams.length, 3);
    assert.ok(hageziUpstreams.every((upstream) => upstream.url instanceof URL));
  });

  await test("Application timeout stays below the route execution ceiling", async () => {
    const primaryRoute = await readFile(new URL("../src/app/api/doh/dns-query/route.ts", import.meta.url), "utf8");
    const providerRoute = await readFile(new URL("../src/app/api/doh/[provider]/dns-query/route.ts", import.meta.url), "utf8");
    const dohSourceText = await readFile(new URL("../src/lib/doh.ts", import.meta.url), "utf8");
    const timeoutMs = Number(/const DEFAULT_TIMEOUT_MS = ([\d_]+);/.exec(dohSourceText)?.[1].replaceAll("_", ""));
    for (const route of [primaryRoute, providerRoute]) {
      const maxDuration = Number(/export const maxDuration = (\d+);/.exec(route)?.[1]);
      assert.ok(Number.isFinite(maxDuration) && timeoutMs < maxDuration * 1_000, "app deadline must fit inside maxDuration");
    }
  });

  await test("PROXY_VERSION matches package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(doh.PROXY_VERSION, pkg.version, "PROXY_VERSION must match package.json");
  });

  await test("Copyright year is a fixed constant, not computed at render time", async () => {
    const page = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
    assert.match(page, /COPYRIGHT_YEAR/);
    assert.doesNotMatch(page, /new Date\(\)\.getFullYear\(\)/);
    const site = await readFile(new URL("../src/lib/site.ts", import.meta.url), "utf8");
    assert.match(site, /export const COPYRIGHT_YEAR = \d{4};/);
  });

  await test("Non-error upstream statuses are never relayed as-is", async () => {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://status-204.test/dns-query" }],
      timeoutMs: 100,
      failover: false,
    });
    assert.equal(response.status, 502);
  });

  await test("Circuit breaker re-opens after a single failed half-open probe", async () => {
    const hits = { a: 0, b: 0 };
    globalThis.fetch = async (url) => {
      if (String(url).includes("half-open-a.test")) {
        hits.a += 1;
        return new Response(null, { status: 503 });
      }
      hits.b += 1;
      return new Response(validResponse(), { status: 200, headers: { "content-type": "application/dns-message" } });
    };
    const options = {
      upstreams: [{ endpoint: "https://half-open-a.test/dns-query" }, { endpoint: "https://half-open-b.test/dns-query" }],
      timeoutMs: 1_000,
      failover: true,
    };
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200); // opens A
      assert.equal(hits.a, 3);
      await doh.proxyRequest(getRequest(), options); // still open: A skipped
      assert.equal(hits.a, 3);
      now += 31_000; // cooldown elapsed -> half-open probe
      await doh.proxyRequest(getRequest(), options);
      assert.equal(hits.a, 4, "half-open state must probe A once");
      await doh.proxyRequest(getRequest(), options);
      assert.equal(hits.a, 4, "one failed probe must re-open the breaker immediately");
    } finally {
      Date.now = realNow;
    }
  });

  await test("Blank HAGEZI_ROTATION_SECONDS falls back to the default interval", async () => {
    const saved = process.env.HAGEZI_ROTATION_SECONDS;
    const realNow = Date.now;
    try {
      // Pick a time where the 60 s slot and the 1800 s slot map to different upstreams.
      Date.now = () => 1_800_000 * 7 + 60_000 * 2; // 1800 s slot = 7 % 3 = 1; 60 s slot = 212 % 3 = 2
      process.env.HAGEZI_ROTATION_SECONDS = "";
      const blank = doh.getHageziUpstreams()[0].endpoint;
      delete process.env.HAGEZI_ROTATION_SECONDS;
      const unset = doh.getHageziUpstreams()[0].endpoint;
      assert.equal(blank, unset);
    } finally {
      Date.now = realNow;
      if (saved === undefined) delete process.env.HAGEZI_ROTATION_SECONDS;
      else process.env.HAGEZI_ROTATION_SECONDS = saved;
    }
  });
  await test("DoH GET tolerates padded base64url dns parameter", async () => {
    globalThis.fetch = async () =>
      new Response(validResponse(), {
        status: 200,
        headers: { "content-type": "application/dns-message" },
      });

    const base64url = Buffer.from(validQuery()).toString("base64url");
    const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
    const response = await doh.proxyRequest(
      new Request(`https://proxy.test/api/doh/dns-query?dns=${base64url}${padding}`, { method: "GET" }),
      { upstreams: [{ endpoint: "https://upstream.test/dns-query" }], timeoutMs: 100, failover: false },
    );

    assert.equal(response.status, 200);
  });

  await test("DoH relays an upstream rejection even when a later upstream fails", async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      if (String(url).includes("blocked.test")) {
        return new Response("egress blocked", { status: 403 });
      }
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("network down")), 25));
    };

    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [
        { endpoint: "https://blocked.test/dns-query" },
        { endpoint: "https://slow.test/dns-query" },
      ],
      timeoutMs: 5_000,
      failover: true,
    });

    assert.equal(calls, 2);
    assert.equal(response.status, 403);
    assert.match(await response.text(), /rejected/);
  });

  await test("GET relays a capped upstream max-age as private; POST stays no-store", async () => {
    globalThis.fetch = async () =>
      new Response(validResponse(), {
        status: 200,
        headers: { "content-type": "application/dns-message", "cache-control": "max-age=86400" },
      });
    const options = { upstreams: [{ endpoint: "https://cache-hint.test/dns-query" }], timeoutMs: 500, failover: false };
    const get = await doh.proxyRequest(getRequest(), options);
    assert.equal(get.headers.get("cache-control"), "private, max-age=300");
    const post = await doh.proxyRequest(postRequest(new Blob([validQuery()]).stream()), options);
    assert.match(post.headers.get("cache-control"), /no-store/);
  });

  await test("Failover hands unused budget to later upstreams", async () => {
    let lastTimeout = 0;
    globalThis.fetch = async (url, init) => {
      const host = new URL(String(url)).hostname;
      if (host !== "last.test") return new Response("no", { status: 403 });
      const started = Date.now();
      await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          lastTimeout = Date.now() - started;
          reject(new Error("aborted"));
        });
      });
    };
    await doh.proxyRequest(getRequest(), {
      upstreams: [
        { endpoint: "https://a.test/dns-query" },
        { endpoint: "https://b.test/dns-query" },
        { endpoint: "https://last.test/dns-query" },
      ],
      timeoutMs: 2_400,
      failover: true,
    });
    assert.ok(lastTimeout > 1_500, `last upstream should get the remaining budget, got ${lastTimeout} ms`);
  });

  await test("Half-open breaker lets exactly one concurrent probe through", async () => {
    let hits = 0;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let healthy = false;
    globalThis.fetch = async () => {
      hits += 1;
      if (!healthy) return new Response("x", { status: 503 });
      await gate;
      return new Response(validResponse(), { status: 200, headers: { "content-type": "application/dns-message" } });
    };
    const options = { upstreams: [{ endpoint: "https://probe-once.test/dns-query" }, { endpoint: "https://probe-other.test/dns-query" }], timeoutMs: 500, failover: true };
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      for (let i = 0; i < 3; i += 1) await doh.proxyRequest(getRequest(), options);
      now += 31_000;
      healthy = true;
      hits = 0;
      const inflight = [doh.proxyRequest(getRequest(), options), doh.proxyRequest(getRequest(), options), doh.proxyRequest(getRequest(), options)];
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(hits, 3, "one probe on the recovering upstream plus one call each on the healthy fallback");
      release();
      await Promise.all(inflight);
    } finally {
      Date.now = realNow;
    }
  });

  await test("One client IP cannot hold more than its share of in-flight slots", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    globalThis.fetch = async () => {
      await gate;
      return new Response(validResponse(), { status: 200, headers: { "content-type": "application/dns-message" } });
    };
    const options = { upstreams: [{ endpoint: "https://per-ip.test/dns-query" }], timeoutMs: 2_000, failover: false };
    const withIp = (ip) => {
      const base = getRequest();
      return new Request(base.url, { headers: { "x-real-ip": ip } });
    };
    const held = Array.from({ length: doh.MAX_IN_FLIGHT_PER_IP }, () => doh.proxyRequest(withIp("192.0.2.50"), options));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await doh.proxyRequest(withIp("192.0.2.50"), options)).status, 503);
    release();
    assert.ok((await Promise.all(held)).every((response) => response.status === 200));
    assert.equal((await doh.proxyRequest(withIp("192.0.2.50"), options)).status, 200);
  });

  await test("A half-open probe is reserved only when the upstream is actually contacted", async () => {
    const hits = { a: 0, b: 0 };
    let aHealthy = false;
    globalThis.fetch = async (url) => {
      if (String(url).includes("probe-leak-a.test")) {
        hits.a += 1;
        if (!aHealthy) return new Response(null, { status: 503 });
      } else {
        hits.b += 1;
      }
      return new Response(validResponse(), { status: 200, headers: { "content-type": "application/dns-message" } });
    };
    const a = { endpoint: "https://probe-leak-a.test/dns-query" };
    const b = { endpoint: "https://probe-leak-b.test/dns-query" };
    const aFirst = { upstreams: [a, b], timeoutMs: 1_000, failover: true };
    const bFirst = { upstreams: [b, a], timeoutMs: 1_000, failover: true };
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await doh.proxyRequest(getRequest(), aFirst)).status, 200); // opens A
      assert.equal(hits.a, 3);

      aHealthy = true;
      now += 31_000; // cooldown elapsed: A is half-open
      assert.equal((await doh.proxyRequest(getRequest(), bFirst)).status, 200); // B answers first; A is not contacted
      assert.equal(hits.a, 3);

      now += 1_000; // well inside the 5 s probe TTL
      assert.equal((await doh.proxyRequest(getRequest(), aFirst)).status, 200);
      assert.equal(hits.a, 4, "an unused probe must not lock out a recovered upstream");
      assert.equal((await doh.proxyRequest(getRequest(), aFirst)).status, 200);
      assert.equal(hits.a, 5, "a successful probe closes the breaker");
    } finally {
      Date.now = realNow;
    }
  });

  await test("A wrong upstream content type fails over without tripping the breaker", async () => {
    let wrongCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("wrong-ct.test")) {
        wrongCalls += 1;
        return new Response(validResponse(), { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(validResponse(), { status: 200, headers: { "content-type": "application/dns-message" } });
    };
    const options = {
      upstreams: [{ endpoint: "https://wrong-ct.test/dns-query" }, { endpoint: "https://right-ct.test/dns-query" }],
      timeoutMs: 1_000,
      failover: true,
    };
    for (let i = 0; i < 5; i += 1) assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
    assert.equal(wrongCalls, 5, "client-independent invalid responses must not open the breaker");

    const sole = await doh.proxyRequest(getRequest(), { ...options, upstreams: [options.upstreams[0]], failover: false });
    assert.equal(sole.status, 502);
  });

  await test("Upstream responses over 65535 bytes are rejected and failover continues", async () => {
    const oversized = new Uint8Array(65_536);
    const seen = [];
    globalThis.fetch = async (url) => {
      const host = new URL(String(url)).hostname;
      seen.push(host);
      if (host === "big-declared.test") {
        return new Response(oversized, { status: 200, headers: { "content-type": "application/dns-message", "content-length": "65536" } });
      }
      if (host === "big-streamed.test") {
        return new Response(oversized, { status: 200, headers: { "content-type": "application/dns-message" } });
      }
      return new Response(validResponse(), { status: 200, headers: { "content-type": "application/dns-message" } });
    };
    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [
        { endpoint: "https://big-declared.test/dns-query" },
        { endpoint: "https://big-streamed.test/dns-query" },
        { endpoint: "https://small.test/dns-query" },
      ],
      timeoutMs: 2_000,
      failover: true,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ["big-declared.test", "big-streamed.test", "small.test"]);
  });

  await test("Handler-level 405 for unsupported methods carries an Allow header", async () => {
    globalThis.fetch = async () => {
      throw new Error("fetch must not run for unsupported methods");
    };
    const response = await doh.proxyRequest(getLikeRequest("PUT"), {
      upstreams: [{ endpoint: "https://never-reached.test/dns-query" }],
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST, HEAD, OPTIONS");
    assert.equal(await response.text(), "Method Not Allowed");
  });

  await test("HAGEZI_ROTATION_MODE=request round-robins the primary resolver per request", () => {
    const saved = process.env.HAGEZI_ROTATION_MODE;
    try {
      process.env.HAGEZI_ROTATION_MODE = " Request "; // trimmed and case-insensitive
      const firsts = Array.from({ length: 4 }, () => doh.getHageziUpstreams()[0].endpoint);
      assert.equal(new Set(firsts.slice(0, 3)).size, 3, "three consecutive requests start on three different resolvers");
      assert.equal(firsts[3], firsts[0], "the cycle repeats after one full round");
      assert.equal(new Set(doh.getHageziUpstreams().map((upstream) => upstream.endpoint)).size, 3, "every rotation keeps all upstreams");
    } finally {
      if (saved === undefined) delete process.env.HAGEZI_ROTATION_MODE;
      else process.env.HAGEZI_ROTATION_MODE = saved;
    }
  });

  await test("HAGEZI_ROTATION_SECONDS is clamped to 60-86400 seconds and bad values use the default", () => {
    const savedSeconds = process.env.HAGEZI_ROTATION_SECONDS;
    const savedMode = process.env.HAGEZI_ROTATION_MODE;
    const realNow = Date.now;
    const firstAt = (seconds, now) => {
      process.env.HAGEZI_ROTATION_SECONDS = seconds;
      Date.now = () => now;
      return doh.getHageziUpstreams()[0].endpoint;
    };
    try {
      delete process.env.HAGEZI_ROTATION_MODE;
      const minute = 60_000 * 300; // slot 300 (% 3 === 0) at 60 s
      assert.equal(firstAt("1", minute), firstAt("1", minute + 59_000), "1 s is raised to 60 s");

      const day = 86_400_000 * 3;
      assert.equal(firstAt("999999", day), firstAt("999999", day + 86_399_000), "huge values are capped at 86400 s");
      assert.notEqual(firstAt("999999", day), firstAt("999999", day + 86_400_000));

      const half = 1_800_000 * 3;
      assert.equal(firstAt("abc", half), firstAt("abc", half + 1_799_000), "non-numeric falls back to 1800 s");
      assert.notEqual(firstAt("abc", half), firstAt("abc", half + 1_800_000));
    } finally {
      Date.now = realNow;
      if (savedSeconds === undefined) delete process.env.HAGEZI_ROTATION_SECONDS;
      else process.env.HAGEZI_ROTATION_SECONDS = savedSeconds;
      if (savedMode !== undefined) process.env.HAGEZI_ROTATION_MODE = savedMode;
    }
  });
} finally {
  globalThis.fetch = originalFetch;
}
