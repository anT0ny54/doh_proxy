/**
 * Shared helper for the node:test suites: transpile TypeScript sources to
 * data-URL modules so the tests exercise the real src/ code without a build
 * step. `@/lib/*` imports are resolved recursively and `next/server` is
 * replaced by a small stub. DOH_PROXY_VERSION, which next.config.ts inlines
 * from package.json at build time, is set from package.json here.
 *
 * Configuration (src/lib/config.ts) is read once per module instance, so
 * suites that need a different environment set process.env and then load a
 * FRESH instance with `{ fresh: true }`, which re-evaluates the whole import
 * graph instead of reusing cached modules.
 */
import { readFile } from "node:fs/promises";
import ts from "typescript";

const SRC = new URL("../../src/", import.meta.url);

function toDataUrl(source, filename) {
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  return `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
}

/** Minimal stand-in for `next/server`, enough for src/lib/doh.ts and src/proxy.ts. */
const NEXT_SERVER_STUB = `
export class NextResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  }
  static next(init = {}) {
    const response = new NextResponse(null, { status: 200 });
    response.requestHeaders = init.request?.headers;
    return response;
  }
  async text() {
    if (this.body === null || this.body === undefined) return "";
    if (typeof this.body === "string") return this.body;
    return new TextDecoder().decode(new Uint8Array(this.body));
  }
  async arrayBuffer() {
    if (this.body === null || this.body === undefined) return new ArrayBuffer(0);
    if (typeof this.body === "string") return new TextEncoder().encode(this.body).buffer;
    return this.body instanceof ArrayBuffer ? this.body : new Uint8Array(this.body).slice().buffer;
  }
}
`;

const nextServerUrl = toDataUrl(NEXT_SERVER_STUB, "next-server-stub.ts");
process.env.DOH_PROXY_VERSION = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version;

let generation = 0;

/** Builds the data URL for a src/ file, resolving its imports first. */
async function moduleUrl(path, cache, tag) {
  if (cache.has(path)) return cache.get(path);
  let source = await readFile(new URL(path, SRC), "utf8");
  const replacements = new Map([["next/server", nextServerUrl]]);
  for (const [, name] of source.matchAll(/from "@\/lib\/([\w-]+)"/g)) {
    replacements.set(`@/lib/${name}`, await moduleUrl(`lib/${name}.ts`, cache, tag));
  }
  for (const [from, to] of replacements) source = source.replaceAll(`from "${from}"`, `from "${to}"`);
  // The tag gives fresh graphs distinct URLs, so Node evaluates them anew.
  const url = toDataUrl(`${source}\n// instance ${tag}\n`, path);
  cache.set(path, url);
  return url;
}

const sharedCache = new Map();

/**
 * Imports src/<path> (e.g. "lib/dns.ts", "proxy.ts"). With `fresh: true` the
 * module and everything it imports are re-evaluated, picking up the current
 * process.env.
 */
export async function importSource(path, { fresh = false } = {}) {
  const cache = fresh ? new Map() : sharedCache;
  const tag = fresh ? `fresh-${(generation += 1)}` : "shared";
  return import(await moduleUrl(path, cache, tag));
}

/** Loads the real src/lib/doh.ts. */
export function importDoh(options) {
  return importSource("lib/doh.ts", options);
}
