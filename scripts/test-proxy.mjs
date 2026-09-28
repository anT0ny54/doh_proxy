import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { importTypeScript, toDataUrl } from "./lib/transpile-source.mjs";

const rateLimitSource = await readFile(new URL("../src/lib/rate-limit.ts", import.meta.url), "utf8");

const rateLimitUrl = toDataUrl(rateLimitSource, "rate-limit.ts");
const clientIpUrl = toDataUrl(await readFile(new URL("../src/lib/client-ip.ts", import.meta.url), "utf8"), "client-ip.ts");
const { WINDOW_LIMIT } = await import(rateLimitUrl);
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

const proxy = await importTypeScript("../proxy.ts", import.meta.url, {
  "next/server": nextServerUrl,
  "./src/lib/rate-limit": rateLimitUrl,
  "./src/lib/client-ip": clientIpUrl,
});

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
  for (let i = 0; i < WINDOW_LIMIT; i += 1) {
    results.push(proxy.default(request("203.0.113.10", `tenant-${i}.example`)));
  }

  assert.ok(results.every((response) => response.status === 200));

  const limited = proxy.default(request("203.0.113.10", "another-tenant.example"));
  assert.equal(limited.status, 429);

  const differentIp = proxy.default(request("203.0.113.11", "another-tenant.example"));
  assert.equal(differentIp.status, 200);
});

test("Proxy normalizes ports, IPv4-mapped IPv6 and IPv6 /64s into one key", () => {
  const ips = ["198.51.100.7:1111", "198.51.100.7:2222", "::ffff:198.51.100.7", "[::ffff:198.51.100.7]:99"];
  for (let i = 0; i < WINDOW_LIMIT; i += 1) proxy.default(request(ips[i % ips.length], "h"));
  assert.equal(proxy.default(request("198.51.100.7", "h")).status, 429);

  for (let i = 0; i < WINDOW_LIMIT; i += 1) proxy.default(request(`2001:db8:1:2:${i.toString(16)}::1`, "h"));
  assert.equal(proxy.default(request("2001:db8:1:2:ffff::9", "h")).status, 429);

  assert.equal(proxy.default(request("not-an-ip", "h")).status, 200);
});
