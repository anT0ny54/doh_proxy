import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dnsAnswer, oversizedResponse, validQuery, validResponse } from "./lib/dns-fixtures.mjs";
import { importDoh } from "./lib/transpile-source.mjs";

// Rotation/override settings are exercised in test-config.mjs.
delete process.env.HAGEZI_UPSTREAM_ENDPOINTS;
delete process.env.HAGEZI_ROTATION_MODE;
delete process.env.HAGEZI_ROTATION_SECONDS;

const doh = await importDoh();

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
      return dnsAnswer();
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
      return dnsAnswer();
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

  await test("The upstream deadline still fires after garbage collection", async () => {
    // Regression guard: AbortSignal.any() over an unreferenced
    // AbortSignal.timeout() stops firing once the timeout signal is collected.
    globalThis.fetch = (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        globalThis.gc?.();
      });
    const started = Date.now();
    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://gc-timeout.test/dns-query" }],
      timeoutMs: 300,
      failover: false,
    });
    assert.equal(response.status, 502);
    assert.ok(Date.now() - started < 1_000);
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
    // The 25 ms cancel timeout plus event-loop overhead can exceed 400 ms on a
    // loaded runner; the bound that matters is that it stays far below the
    // request deadline.
    assert.ok(Date.now() - started < 1_000, "body cancellation must not extend the deadline indefinitely");
  });

  await test("A synchronous POST-body cancellation error does not hide the 413 response", async () => {
    const oversizedBody = {
      getReader() {
        return {
          read() {
            return Promise.resolve({ done: false, value: new Uint8Array(4_097) });
          },
          cancel() {
            throw new Error("stream cancellation failed synchronously");
          },
          releaseLock() {},
        };
      },
    };

    globalThis.fetch = async () => {
      throw new Error("fetch must not run for an oversized request body");
    };

    const response = await doh.proxyRequest(postRequest(oversizedBody), {
      upstreams: [{ endpoint: "https://never-reached.test/dns-query" }],
      timeoutMs: 1_000,
      failover: false,
    });

    assert.equal(response.status, 413);
    assert.equal(await response.text(), "Payload too large");
  });

  await test("A failing POST body stream gets 400 instead of escaping the handler", async () => {
    globalThis.fetch = async () => {
      throw new Error("fetch must not run after a body read error");
    };

    const failingBody = {
      getReader() {
        return {
          read() {
            return Promise.reject(new Error("client aborted the upload"));
          },
          cancel() {
            return Promise.resolve();
          },
          releaseLock() {},
        };
      },
    };

    const response = await doh.proxyRequest(postRequest(failingBody), {
      upstreams: [{ endpoint: "https://never-reached.test/dns-query" }],
      timeoutMs: 1_000,
      failover: false,
    });

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Request body error");
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
      return dnsAnswer();
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
    const big = oversizedResponse();
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
      return dnsAnswer(validResponse(query));
    };
    const options = { upstreams: [{ endpoint: "https://slow-client.test/dns-query" }], timeoutMs: 250, failover: false };

    for (let i = 0; i < 4; i += 1) {
      const slow = await doh.proxyRequest(postRequest(slowBody), options);
      // On a heavily loaded runner the 200 ms chunk can land after the 250 ms
      // deadline, which is the legitimate 408 body-timeout path instead.
      assert.ok([502, 408].includes(slow.status), `expected 502 or 408, got ${slow.status}`);
    }
    assert.equal(calls, 0, "no upstream attempt should be made with a sub-100 ms budget");

    // A normal follow-up request must still be served normally.
    const ok = await doh.proxyRequest(getRequest(query), options);
    assert.equal(ok.status, 200);
    assert.equal(calls, 1);
  });

  await test("Request-rejection statuses are relayed at once and never open the circuit breaker", async () => {
    for (const status of [400, 413, 414, 415]) {
      const seen = [];
      globalThis.fetch = async (url) => {
        seen.push(new URL(String(url)).hostname);
        return new Response(null, { status });
      };

      const options = {
        upstreams: [{ endpoint: `https://reject-${status}.test/dns-query` }, { endpoint: `https://reject-${status}-b.test/dns-query` }],
        timeoutMs: 1_000,
        failover: true,
      };
      for (let i = 0; i < 5; i += 1) {
        const response = await doh.proxyRequest(getRequest(), options);
        assert.equal(response.status, status);
        assert.equal(await response.text(), "DNS upstream rejected request");
      }
      // No failover replay of a bad request, and the first upstream is still
      // contacted every time (its breaker never opened).
      assert.deepEqual(seen, Array(5).fill(`reject-${status}.test`), `status ${status}`);
    }
  });

  await test("Open circuit breaker is bypassed when every upstream is open", async () => {
    let calls = 0;
    let healthy = false;
    globalThis.fetch = async () => {
      calls += 1;
      if (!healthy) return new Response(null, { status: 503 });
      return dnsAnswer();
    };

    const options = { upstreams: [{ endpoint: "https://flaky.test/dns-query" }], timeoutMs: 100, failover: true };
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

  await test("HaGeZi upstream set is pre-normalized and complete", () => {
    const hageziUpstreams = doh.getHageziUpstreams();
    assert.equal(hageziUpstreams.length, 3);
    assert.equal(new Set(hageziUpstreams.map((upstream) => upstream.endpoint)).size, 3);
    assert.ok(hageziUpstreams.every((upstream) => upstream.getPrefix === `${upstream.href}?`));
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

  await test("A client disconnect aborts the upstream fetch and does not blame the upstream", async () => {
    let aborted = false;
    let calls = 0;
    globalThis.fetch = (_url, init) => {
      calls += 1;
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    };

    const controller = new AbortController();
    const request = new Request(getRequest().url, { signal: controller.signal });
    const pending = doh.proxyRequest(request, {
      upstreams: [
        { endpoint: "https://first.test/dns-query" },
        { endpoint: "https://second.test/dns-query" },
      ],
      timeoutMs: 2_000,
      failover: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const started = Date.now();
    const response = await pending;
    assert.equal(aborted, true, "the upstream fetch must be aborted by the client disconnect");
    assert.ok(Date.now() - started < 500, "must resolve promptly instead of at the deadline");
    assert.equal(calls, 1, "failover must not contact the next upstream for a disconnected client");
    assert.equal(response.status, 502);

    // The disconnect must not have counted as an upstream failure: the breaker
    // is untouched, so a subsequent request to the same upstream is not skipped.
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(new URL(String(url)).hostname);
      return dnsAnswer();
    };
    for (let i = 0; i < 3; i += 1) {
      const after = await doh.proxyRequest(getRequest(), {
        upstreams: [{ endpoint: "https://first.test/dns-query" }, { endpoint: "https://second.test/dns-query" }],
        timeoutMs: 1_000,
        failover: true,
      });
      assert.equal(after.status, 200);
    }
    assert.deepEqual(seen, ["first.test", "first.test", "first.test"]);
  });

  await test("Wall-clock jumps do not truncate the request deadline or skip failover", async () => {
    const realNow = Date.now;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        // The request deadline is elapsed-time based, not wall-clock based.
        Date.now = () => realNow() + 60 * 60 * 1_000;
        return new Response(null, { status: 403 });
      }
      return dnsAnswer();
    };

    try {
      const response = await doh.proxyRequest(getRequest(), {
        upstreams: [
          { endpoint: "https://clock-jump-first.test/dns-query" },
          { endpoint: "https://clock-jump-second.test/dns-query" },
        ],
        timeoutMs: 1_000,
        failover: true,
      });
      assert.equal(response.status, 200);
      assert.equal(calls, 2, "a wall-clock step must not consume the remaining request budget");
    } finally {
      Date.now = realNow;
    }
  });

  await test("Wall-clock jumps do not prematurely time out a completed POST body", async () => {
    const realNow = Date.now;
    const query = validQuery();
    let step = 0;
    const body = {
      getReader() {
        return {
          read() {
            step += 1;
            if (step === 1) {
              Date.now = () => realNow() + 60 * 60 * 1_000;
              return Promise.resolve({ done: false, value: query });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          cancel() { return Promise.resolve(); },
          releaseLock() {},
        };
      },
    };
    globalThis.fetch = async () => dnsAnswer(validResponse(query));

    try {
      const response = await doh.proxyRequest(postRequest(body), {
        upstreams: [{ endpoint: "https://clock-jump-post.test/dns-query" }],
        timeoutMs: 1_000,
        failover: false,
      });
      assert.equal(response.status, 200);
    } finally {
      Date.now = realNow;
    }
  });

  await test("An errored upstream response stream releases its reader lock before failover", async () => {
    let upstreamBody;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        upstreamBody = new ReadableStream({
          start(controller) { controller.error(new Error("upstream body interrupted")); },
        });
        return new Response(upstreamBody, {
          status: 200,
          headers: { "content-type": "application/dns-message" },
        });
      }
      return dnsAnswer();
    };

    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [
        { endpoint: "https://stream-error.test/dns-query" },
        { endpoint: "https://stream-recovery.test/dns-query" },
      ],
      timeoutMs: 1_000,
      failover: true,
    });

    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(upstreamBody.locked, false, "an errored but settled stream must not remain locked");
  });

  await test("A negative upstream Content-Length is rejected and failover continues", async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return dnsAnswer(validResponse(), { "content-length": "-1" });
      }
      return dnsAnswer();
    };

    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [
        { endpoint: "https://first.test/dns-query" },
        { endpoint: "https://second.test/dns-query" },
      ],
      timeoutMs: 1_000,
      failover: true,
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2, "the negative Content-Length response must be skipped");
    assert.match(calls[1], /second\.test/);
  });

  await test("PROXY_VERSION is read from package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(doh.PROXY_VERSION, pkg.version);
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
      return dnsAnswer();
    };
    const options = {
      upstreams: [{ endpoint: "https://half-open-a.test/dns-query" }, { endpoint: "https://half-open-b.test/dns-query" }],
      timeoutMs: 1_000,
      failover: true,
    };
    const originalPerformanceNow = performance.now;
    const realNow = originalPerformanceNow.bind(performance);
    let now = realNow();
    performance.now = () => now;
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
      performance.now = originalPerformanceNow;
    }
  });

  await test("Circuit-breaker cooldown uses monotonic time, not wall-clock jumps", async () => {
    const realWallNow = Date.now;
    const originalPerformanceNow = performance.now;
    const realMonotonicNow = originalPerformanceNow.bind(performance);
    let monotonic = realMonotonicNow();
    let wallOffset = 0;
    performance.now = () => monotonic;
    Date.now = () => realWallNow() + wallOffset;

    const hits = { a: 0, b: 0 };
    let aHealthy = false;
    globalThis.fetch = async (url) => {
      if (String(url).includes("clock-breaker-a.test")) {
        hits.a += 1;
        return aHealthy ? dnsAnswer() : new Response(null, { status: 503 });
      }
      hits.b += 1;
      return dnsAnswer();
    };
    const options = {
      upstreams: [
        { endpoint: "https://clock-breaker-a.test/dns-query" },
        { endpoint: "https://clock-breaker-b.test/dns-query" },
      ],
      timeoutMs: 1_000,
      failover: true,
    };

    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 3, "three failures trip the breaker");

      wallOffset += 60 * 60 * 1_000;
      assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 3, "a forward wall-clock jump must not expire the cooldown");

      monotonic += 31_000;
      aHealthy = true;
      assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 4, "elapsed monotonic time permits a half-open recovery probe");
    } finally {
      Date.now = realWallNow;
      performance.now = originalPerformanceNow;
    }
  });

  await test("A wall-clock jump does not expire an active half-open probe", async () => {
    const realWallNow = Date.now;
    const originalPerformanceNow = performance.now;
    const realMonotonicNow = originalPerformanceNow.bind(performance);
    let monotonic = realMonotonicNow();
    performance.now = () => monotonic;

    const hits = { a: 0, b: 0 };
    let hangProbe = false;
    let releaseProbe;
    globalThis.fetch = async (url) => {
      if (String(url).includes("clock-probe-a.test")) {
        hits.a += 1;
        if (hangProbe) {
          await new Promise((resolve) => { releaseProbe = resolve; });
        }
        return new Response(null, { status: 503 });
      }
      hits.b += 1;
      return dnsAnswer();
    };
    const options = {
      upstreams: [
        { endpoint: "https://clock-probe-a.test/dns-query" },
        { endpoint: "https://clock-probe-b.test/dns-query" },
      ],
      timeoutMs: 2_000,
      failover: true,
    };

    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      monotonic += 31_000;
      hangProbe = true;
      const pendingProbe = doh.proxyRequest(getRequest(), options);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(hits.a, 4, "the first half-open probe has started");

      Date.now = () => realWallNow() + 60 * 60 * 1_000;
      assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 4, "a wall-clock jump must not expire the active probe lease");

      releaseProbe();
      assert.equal((await pendingProbe).status, 200);
    } finally {
      Date.now = realWallNow;
      performance.now = originalPerformanceNow;
    }
  });

  await test("DoH GET tolerates padded base64url dns parameter", async () => {
    globalThis.fetch = async () =>
      dnsAnswer();

    const base64url = Buffer.from(validQuery()).toString("base64url");
    const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
    const response = await doh.proxyRequest(
      new Request(`https://proxy.test/api/doh/dns-query?dns=${base64url}${padding}`, { method: "GET" }),
      { upstreams: [{ endpoint: "https://upstream.test/dns-query" }], timeoutMs: 100, failover: false },
    );

    assert.equal(response.status, 200);
  });

  await test("DoH GET rejects incorrectly padded base64url before fetching", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return dnsAnswer();
    };

    const base64url = Buffer.from(validQuery()).toString("base64url");
    const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
    const response = await doh.proxyRequest(
      new Request(`https://proxy.test/api/doh/dns-query?dns=${base64url}${padding}=`, { method: "GET" }),
      { upstreams: [{ endpoint: "https://upstream.test/dns-query" }], timeoutMs: 100, failover: false },
    );

    assert.equal(response.status, 400);
    assert.equal(fetches, 0);
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
      dnsAnswer(validResponse(), { "cache-control": "max-age=86400" });
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
      return dnsAnswer();
    };
    const options = { upstreams: [{ endpoint: "https://probe-once.test/dns-query" }, { endpoint: "https://probe-other.test/dns-query" }], timeoutMs: 500, failover: true };
    const originalPerformanceNow = performance.now;
    const realNow = originalPerformanceNow.bind(performance);
    let now = realNow();
    performance.now = () => now;
    try {
      for (let i = 0; i < 3; i += 1) await doh.proxyRequest(getRequest(), options);
      now += 31_000;
      healthy = true;
      hits = 0;
      // Both upstreams tripped above, so both are half-open now.
      const inflight = [doh.proxyRequest(getRequest(), options), doh.proxyRequest(getRequest(), options), doh.proxyRequest(getRequest(), options)];
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(hits, 2, "exactly one probe per half-open upstream; the third request does not pile on");
      release();
      const statuses = (await Promise.all(inflight)).map((response) => response.status);
      assert.deepEqual(statuses, [200, 200, 502]);
    } finally {
      performance.now = originalPerformanceNow;
    }
  });

  await test("One client IP cannot hold more than its share of in-flight slots", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    globalThis.fetch = async () => {
      await gate;
      return dnsAnswer();
    };
    const options = { upstreams: [{ endpoint: "https://per-ip.test/dns-query" }], timeoutMs: 2_000, failover: false };
    const withIp = (ip) => {
      const base = getRequest();
      // src/proxy.ts sets this header from the resolved client address.
      return new Request(base.url, { headers: { "x-doh-client-key": ip } });
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
      return dnsAnswer();
    };
    const a = { endpoint: "https://probe-leak-a.test/dns-query" };
    const b = { endpoint: "https://probe-leak-b.test/dns-query" };
    const aFirst = { upstreams: [a, b], timeoutMs: 1_000, failover: true };
    const bFirst = { upstreams: [b, a], timeoutMs: 1_000, failover: true };
    const originalPerformanceNow = performance.now;
    const realNow = originalPerformanceNow.bind(performance);
    let now = realNow();
    performance.now = () => now;
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
      performance.now = originalPerformanceNow;
    }
  });

  await test("A non-retryable answer to a half-open probe releases the probe slot", async () => {
    const hits = { a: 0, b: 0 };
    let aStatus = 503;
    globalThis.fetch = async (url) => {
      if (String(url).includes("probe-release-a.test")) {
        hits.a += 1;
        return new Response(null, { status: aStatus });
      }
      hits.b += 1;
      return dnsAnswer();
    };
    const options = {
      upstreams: [{ endpoint: "https://probe-release-a.test/dns-query" }, { endpoint: "https://probe-release-b.test/dns-query" }],
      timeoutMs: 1_000,
      failover: true,
    };
    const originalPerformanceNow = performance.now;
    const realNow = originalPerformanceNow.bind(performance);
    let now = realNow();
    performance.now = () => now;
    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200); // opens A
      assert.equal(hits.a, 3);

      aStatus = 403; // non-retryable: neither a failure nor a success
      now += 31_000; // cooldown elapsed: A is half-open
      assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 4, "the half-open probe reaches A");
      now += 1_000; // well inside the 5 s probe TTL
      assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 5, "an inconclusive probe must not block A for the whole probe TTL");
    } finally {
      performance.now = originalPerformanceNow;
    }
  });

  await test("GET keeps an existing query string on the upstream endpoint", async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return dnsAnswer();
    };
    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://query-keep.test/dns-query?token=abc" }],
      timeoutMs: 1_000,
      failover: false,
    });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    const target = new URL(seen[0]);
    assert.equal(target.searchParams.get("token"), "abc");
    assert.ok(target.searchParams.get("dns"), "the dns parameter is appended");
    assert.equal(seen[0].split("?").length, 2, "exactly one '?' separator");
  });

  await test("A wrong upstream content type fails over and counts against the breaker", async () => {
    let wrongCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("wrong-ct.test")) {
        wrongCalls += 1;
        return new Response(validResponse(), { status: 200, headers: { "content-type": "text/html" } });
      }
      return dnsAnswer();
    };
    const options = {
      upstreams: [{ endpoint: "https://wrong-ct.test/dns-query" }, { endpoint: "https://right-ct.test/dns-query" }],
      timeoutMs: 1_000,
      failover: true,
    };
    for (let i = 0; i < 5; i += 1) assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
    assert.equal(wrongCalls, 3, "a non-DNS 200 is client-independent: three of them open the breaker");

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
      return dnsAnswer();
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

  await test("A probe slot is only released by the attempt that owns it", async () => {
    // A opens; once half-open, request 1 probes A and hangs, request 2 skips A.
    // Request 1's inconclusive end (403) must release its own probe only.
    const hits = { a: 0, b: 0 };
    let aMode = "fail";
    let releaseA;
    globalThis.fetch = async (url) => {
      if (String(url).includes("owner-a.test")) {
        hits.a += 1;
        if (aMode === "fail") return new Response(null, { status: 503 });
        if (aMode === "hang") await new Promise((resolve) => (releaseA = resolve));
        return new Response(null, { status: 403 });
      }
      hits.b += 1;
      return dnsAnswer();
    };
    const options = {
      upstreams: [{ endpoint: "https://owner-a.test/dns-query" }, { endpoint: "https://owner-b.test/dns-query" }],
      timeoutMs: 2_000,
      failover: true,
    };
    const originalPerformanceNow = performance.now;
    const realNow = originalPerformanceNow.bind(performance);
    let now = realNow();
    performance.now = () => now;
    try {
      for (let i = 0; i < 3; i += 1) await doh.proxyRequest(getRequest(), options);
      now += 31_000;
      aMode = "hang";
      const first = doh.proxyRequest(getRequest(), options); // claims A's probe
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(hits.a, 4);
      assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 4, "A is skipped while its probe is in flight");
      aMode = "reject";
      releaseA();
      assert.equal((await first).status, 200);
      assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 5, "the owner released its probe after the inconclusive answer");
    } finally {
      performance.now = originalPerformanceNow;
    }
  });

  await test("A late non-probe failure cannot clear another request's half-open probe", async () => {
    const hits = { a: 0, b: 0 };
    let releaseStaleFailure;
    let releaseProbeFailure;
    let aMode = "fail";
    globalThis.fetch = async (url) => {
      if (String(url).includes("late-failure-a.test")) {
        hits.a += 1;
        if (hits.a === 1) {
          await new Promise((resolve) => (releaseStaleFailure = resolve));
          return new Response(null, { status: 503 });
        }
        if (aMode === "probe-hang") {
          await new Promise((resolve) => (releaseProbeFailure = resolve));
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 503 });
      }
      hits.b += 1;
      return dnsAnswer();
    };

    const endpoint = "https://late-failure-a.test/dns-query";
    const options = {
      upstreams: [{ endpoint }, { endpoint: "https://late-failure-b.test/dns-query" }],
      timeoutMs: 2_000,
      failover: true,
    };
    const originalPerformanceNow = performance.now;
    const realNow = originalPerformanceNow.bind(performance);
    let now = realNow();
    performance.now = () => now;
    try {
      const stale = doh.proxyRequest(getRequest(), options);
      assert.equal(hits.a, 1, "the older request has started and is still pending");

      for (let i = 0; i < 3; i += 1) {
        assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      }
      assert.equal(hits.a, 4, "three concurrent failures trip A while the older request is pending");

      now += 31_000;
      aMode = "probe-hang";
      const probe = doh.proxyRequest(getRequest(), options);
      assert.equal(hits.a, 5, "a new request owns A's half-open probe");
      const breaker = globalThis.__dohProxyState.circuitBreakers.get(endpoint);
      assert.ok(breaker?.probeToken, "the half-open probe has an ownership token");
      const token = breaker.probeToken;

      releaseStaleFailure();
      await stale;
      assert.equal(
        globalThis.__dohProxyState.circuitBreakers.get(endpoint)?.probeToken,
        token,
        "the late failure from a non-probe request must not release the active probe",
      );

      releaseProbeFailure();
      assert.equal((await probe).status, 200);
      assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 5, "the failed probe re-opens the breaker without a duplicate request");
    } finally {
      performance.now = originalPerformanceNow;
    }
  });

  await test("A late non-probe success cannot close another request's half-open breaker", async () => {
    const hits = { a: 0, b: 0 };
    let releaseStaleSuccess;
    let releaseProbeFailure;
    let aMode = "fail";
    globalThis.fetch = async (url) => {
      if (String(url).includes("late-success-a.test")) {
        hits.a += 1;
        if (hits.a === 1) {
          await new Promise((resolve) => (releaseStaleSuccess = resolve));
          return dnsAnswer();
        }
        if (aMode === "probe-hang") {
          await new Promise((resolve) => (releaseProbeFailure = resolve));
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 503 });
      }
      hits.b += 1;
      return dnsAnswer();
    };

    const endpoint = "https://late-success-a.test/dns-query";
    const options = {
      upstreams: [{ endpoint }, { endpoint: "https://late-success-b.test/dns-query" }],
      timeoutMs: 2_000,
      failover: true,
    };
    const originalPerformanceNow = performance.now;
    const realNow = originalPerformanceNow.bind(performance);
    let now = realNow();
    performance.now = () => now;
    try {
      const stale = doh.proxyRequest(getRequest(), options);
      assert.equal(hits.a, 1, "the older request has started and is still pending");

      for (let i = 0; i < 3; i += 1) {
        assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      }
      assert.equal(hits.a, 4, "three concurrent failures trip A while the older request is pending");

      now += 31_000;
      aMode = "probe-hang";
      const probe = doh.proxyRequest(getRequest(), options);
      assert.equal(hits.a, 5, "a new request owns A's half-open probe");
      const breaker = globalThis.__dohProxyState.circuitBreakers.get(endpoint);
      assert.ok(breaker?.probeToken, "the half-open probe has an ownership token");
      const token = breaker.probeToken;

      releaseStaleSuccess();
      assert.equal((await stale).status, 200);
      assert.equal(
        globalThis.__dohProxyState.circuitBreakers.get(endpoint)?.probeToken,
        token,
        "the late success from a non-probe request must not close the breaker or clear its active probe",
      );

      releaseProbeFailure();
      assert.equal((await probe).status, 200);
      assert.equal((await doh.proxyRequest(getRequest(), options)).status, 200);
      assert.equal(hits.a, 5, "the failed probe re-opens the breaker without a duplicate request");
    } finally {
      performance.now = originalPerformanceNow;
    }
  });

  await test("Isolated failures further apart than the failure window do not open the breaker", async () => {
    let hits = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("sporadic-a.test")) {
        hits += 1;
        return new Response(null, { status: 503 });
      }
      return dnsAnswer();
    };
    const options = {
      upstreams: [{ endpoint: "https://sporadic-a.test/dns-query" }, { endpoint: "https://sporadic-b.test/dns-query" }],
      timeoutMs: 1_000,
      failover: true,
    };
    const originalPerformanceNow = performance.now;
    const realNow = originalPerformanceNow.bind(performance);
    let now = realNow();
    performance.now = () => now;
    try {
      for (let i = 0; i < 5; i += 1) {
        await doh.proxyRequest(getRequest(), options);
        now += 31_000;
      }
      assert.equal(hits, 5, "spread-out failures never trip the breaker");
    } finally {
      performance.now = originalPerformanceNow;
    }
  });

  await test("With every breaker open, each upstream is probed by at most one request at a time", async () => {
    const hits = { a: 0, b: 0 };
    const pending = [];
    let hang = false;
    globalThis.fetch = (url) => {
      const key = String(url).includes("storm-a.test") ? "a" : "b";
      hits[key] += 1;
      if (!hang) return Promise.resolve(new Response(null, { status: 503 }));
      return new Promise((resolve) => pending.push(() => resolve(new Response(null, { status: 503 }))));
    };
    const options = {
      upstreams: [{ endpoint: "https://storm-a.test/dns-query" }, { endpoint: "https://storm-b.test/dns-query" }],
      timeoutMs: 2_000,
      failover: true,
    };
    for (let i = 0; i < 3; i += 1) await doh.proxyRequest(getRequest(), options); // opens both
    assert.deepEqual(hits, { a: 3, b: 3 });

    hang = true;
    const concurrent = Array.from({ length: 6 }, () => doh.proxyRequest(getRequest(), options));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(hits, { a: 4, b: 4 }, "one probe per upstream, not one per request");
    while (pending.length > 0) pending.shift()();
    const statuses = (await Promise.all(concurrent)).map((response) => response.status);
    assert.ok(statuses.every((status) => status === 502));
  });

  await test("Provider routes (no failover) keep no circuit-breaker state", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    };
    const options = { upstreams: [{ endpoint: "https://single.test/dns-query" }], timeoutMs: 1_000, failover: false };
    for (let i = 0; i < 5; i += 1) assert.equal((await doh.proxyRequest(getRequest(), options)).status, 502);
    assert.equal(calls, 5);

    // The same endpoint in a failover list is not considered open afterwards.
    globalThis.fetch = async (url) => {
      calls += 1;
      return String(url).includes("single.test") ? dnsAnswer() : new Response(null, { status: 500 });
    };
    calls = 0;
    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://single.test/dns-query" }, { endpoint: "https://other.test/dns-query" }],
      timeoutMs: 1_000,
      failover: true,
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
  });

  await test("Relayed max-age subtracts the upstream Age", async () => {
    const options = { upstreams: [{ endpoint: "https://age.test/dns-query" }], timeoutMs: 500, failover: false };
    globalThis.fetch = async () => dnsAnswer(validResponse(), { "cache-control": "public, max-age=120", age: "100" });
    assert.equal((await doh.proxyRequest(getRequest(), options)).headers.get("cache-control"), "private, max-age=20");
    globalThis.fetch = async () => dnsAnswer(validResponse(), { "cache-control": "max-age=60", age: "90" });
    assert.match((await doh.proxyRequest(getRequest(), options)).headers.get("cache-control"), /no-store/);
  });

  await test("GET upstream URLs drop a fragment and append dns= correctly", async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return dnsAnswer();
    };
    await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://frag.test/dns-query#ignored" }],
      timeoutMs: 500,
      failover: false,
    });
    assert.match(seen[0], /^https:\/\/frag\.test\/dns-query\?dns=[A-Za-z0-9_-]+$/);
  });
} finally {
  globalThis.fetch = originalFetch;
}
