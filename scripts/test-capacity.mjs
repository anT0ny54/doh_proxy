import { test } from "node:test";
import assert from "node:assert/strict";
import { validQuery, validResponse } from "./lib/dns-fixtures.mjs";
import { importDoh } from "./lib/transpile-source.mjs";

const doh = await importDoh();

function getRequest() {
  const dns = Buffer.from(validQuery()).toString("base64url");
  return new Request(`https://proxy.test/api/doh/dns-query?dns=${dns}`, { method: "GET" });
}

const originalFetch = globalThis.fetch;
try {
  await test("Global in-flight ceiling rejects excess work and releases capacity", async () => {
    const pending = [];
    let calls = 0;
    let released = false;
    globalThis.fetch = async () => {
      calls += 1;
      if (released) return new Response(validResponse(), { status: 200, headers: { "content-type": "application/dns-message" } });
      return new Promise((resolve) => pending.push(resolve));
    };

    const requests = Array.from({ length: doh.MAX_IN_FLIGHT_REQUESTS }, () =>
      doh.proxyRequest(getRequest(), {
        upstreams: [{ endpoint: "https://capacity.test/dns-query" }],
        timeoutMs: 1_000,
        failover: false,
      }),
    );

    const startedDeadline = Date.now() + 1_000;
    while (calls < doh.MAX_IN_FLIGHT_REQUESTS && Date.now() < startedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(calls, doh.MAX_IN_FLIGHT_REQUESTS);

    const rejected = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://capacity.test/dns-query" }],
      timeoutMs: 1_000,
      failover: false,
    });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get("retry-after"), "1");

    released = true;
    for (const resolve of pending) {
      resolve(new Response(validResponse(), {
        status: 200,
        headers: { "content-type": "application/dns-message" },
      }));
    }
    const results = await Promise.all(requests);
    assert.ok(results.every((response) => response.status === 200));

    const recovered = await doh.proxyRequest(getRequest(), {
      upstreams: [{ endpoint: "https://capacity.test/dns-query" }],
      timeoutMs: 100,
      failover: false,
    });
    assert.equal(recovered.status, 200);
  });
} finally {
  globalThis.fetch = originalFetch;
}
