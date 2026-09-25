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
const nextServerUrl = toDataUrl(`
export class NextResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  }
  async arrayBuffer() {
    if (this.body === null || this.body === undefined) return new ArrayBuffer(0);
    return this.body instanceof ArrayBuffer ? this.body : new Uint8Array(this.body).slice().buffer;
  }
}
`, "next-server-stub.ts");

dohSource = dohSource
  .replace('from "next/server"', `from "${nextServerUrl}"`)
  .replace('from "@/lib/providers"', `from "${providersUrl}"`)
  .replace('from "@/lib/dns"', `from "${dnsUrl}"`)
  .replace('from "@/lib/upstreams"', `from "${upstreamsUrl}"`);

const doh = await import(toDataUrl(dohSource, "doh.ts"));

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
