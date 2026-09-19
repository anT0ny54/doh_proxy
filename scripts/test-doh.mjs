import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

function toDataUrl(source, filename) {
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
    },
  });
  return `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
}

const dnsSource = await readFile(new URL("../src/lib/dns.ts", import.meta.url), "utf8");
const providersSource = await readFile(new URL("../src/lib/providers.ts", import.meta.url), "utf8");
const upstreamsSource = await readFile(new URL("../src/lib/upstreams.ts", import.meta.url), "utf8");
let dohSource = await readFile(new URL("../src/lib/doh.ts", import.meta.url), "utf8");

const dnsUrl = toDataUrl(dnsSource, "dns.ts");
const providersUrl = toDataUrl(providersSource, "providers.ts");
const upstreamsUrl = toDataUrl(upstreamsSource, "upstreams.ts");
const nextServerSource = `
export class NextResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  }
  async text() {
    if (this.body === null || this.body === undefined) return "";
    if (typeof this.body === "string") return this.body;
    const bytes = this.body instanceof ArrayBuffer ? new Uint8Array(this.body) : new Uint8Array(this.body);
    return new TextDecoder().decode(bytes);
  }
  async arrayBuffer() {
    if (this.body === null || this.body === undefined) return new ArrayBuffer(0);
    if (typeof this.body === "string") return new TextEncoder().encode(this.body).buffer;
    return this.body instanceof ArrayBuffer ? this.body : new Uint8Array(this.body).slice().buffer;
  }
}
`;
const nextServerUrl = toDataUrl(nextServerSource, "next-server-stub.ts");

dohSource = dohSource
  .replace('from "next/server"', `from "${nextServerUrl}"`)
  .replace('from "@/lib/providers"', `from "${providersUrl}"`)
  .replace('from "@/lib/dns"', `from "${dnsUrl}"`)
  .replace('from "@/lib/upstreams"', `from "${upstreamsUrl}"`);

const doh = await import(toDataUrl(dohSource, "doh.ts"));

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

  await test("Non-retryable upstream status is returned directly", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 403 });
    };

    const response = await doh.proxyRequest(getRequest(), {
      upstreams: [
        { endpoint: "https://first.test/dns-query" },
        { endpoint: "https://second.test/dns-query" },
      ],
      timeoutMs: 100,
      failover: true,
    });

    assert.equal(response.status, 403);
    assert.equal(calls, 1);
  });

  await test("Application timeout is below the 3-second route execution ceiling", async () => {
    assert.equal(doh.HAGEZI_TIMEOUT_MS, 2500);
    const hageziUpstreams = doh.getHageziUpstreams();
    assert.equal(hageziUpstreams.length, 3);
    assert.ok(hageziUpstreams.every((upstream) => upstream.url instanceof URL));

    const primaryRoute = await readFile(new URL("../src/app/api/doh/dns-query/route.ts", import.meta.url), "utf8");
    const providerRoute = await readFile(new URL("../src/app/api/doh/[provider]/dns-query/route.ts", import.meta.url), "utf8");
    assert.match(primaryRoute, /export const maxDuration = 3;/);
    assert.match(providerRoute, /export const maxDuration = 3;/);

    const oldRoute = new URL("../src/app/api/doh/[provider]/[format]/route.ts", import.meta.url);
    await assert.rejects(readFile(oldRoute));

    const page = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
    assert.match(page, /COPYRIGHT_YEAR/);
    assert.doesNotMatch(page, /new Date\(\)\.getFullYear\(\)/);
    const site = await readFile(new URL("../src/lib/site.ts", import.meta.url), "utf8");
    assert.match(site, /export const COPYRIGHT_YEAR = 2026;/);
  });
} finally {
  globalThis.fetch = originalFetch;
}
