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

const rateLimitSource = await readFile(new URL("../src/lib/rate-limit.ts", import.meta.url), "utf8");
let proxySource = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");

const rateLimitUrl = toDataUrl(rateLimitSource, "rate-limit.ts");
const nextServerUrl = toDataUrl(`
export class NextResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  }
  static next() {
    return new NextResponse(null, { status: 200 });
  }
}
`, "next-server-stub.ts");

proxySource = proxySource
  .replace('from "next/server"', `from "${nextServerUrl}"`)
  .replace('from "./src/lib/rate-limit"', `from "${rateLimitUrl}"`);

const proxy = await import(toDataUrl(proxySource, "proxy.ts"));

function request(ip, host) {
  return {
    headers: new Headers({
      "x-real-ip": ip,
      host,
    }),
  };
}

test("Proxy rate limit is keyed only by source IP", () => {
  const results = [];
  for (let i = 0; i < 100; i += 1) {
    results.push(proxy.default(request("203.0.113.10", `tenant-${i}.example`)));
  }

  assert.ok(results.every((response) => response.status === 200));

  const limited = proxy.default(request("203.0.113.10", "another-tenant.example"));
  assert.equal(limited.status, 429);

  const differentIp = proxy.default(request("203.0.113.11", "another-tenant.example"));
  assert.equal(differentIp.status, 200);
});
