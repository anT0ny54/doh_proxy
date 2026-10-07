/**
 * Shared helper for the node:test suites: transpile TypeScript sources to
 * data-URL modules so the tests exercise the real src/lib code without a
 * build step or path-alias resolution.
 */
import { readFile } from "node:fs/promises";
import ts from "typescript";

export function toDataUrl(source, filename) {
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
    },
  });
  return `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
}

/**
 * Read a TypeScript source file relative to `baseUrl`, rewrite its import
 * specifiers according to `importMap` ({ importSpecifier: replacementUrl }),
 * transpile, and import the result as a data-URL module.
 */
export async function importTypeScript(path, baseUrl, importMap = {}, filename = path) {
  let source = await readFile(new URL(path, baseUrl), "utf8");
  for (const [from, to] of Object.entries(importMap)) {
    source = source.replaceAll(`from "${from}"`, `from "${to}"`);
  }
  return import(toDataUrl(source, filename));
}

/** Minimal stand-in for `next/server`, enough for src/lib/doh.ts and src/proxy.ts. */
const NEXT_SERVER_STUB = `
export class NextResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  }
  static next() {
    return new NextResponse(null, { status: 200 });
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

export const nextServerUrl = toDataUrl(NEXT_SERVER_STUB, "next-server-stub.ts");

/** Data-URL module for src/lib/<name>.ts (transpiled as-is, no import rewriting). */
export async function libUrl(name) {
  const source = await readFile(new URL(`../../src/lib/${name}.ts`, import.meta.url), "utf8");
  return toDataUrl(source, `${name}.ts`);
}

/** Loads the real src/lib/doh.ts with its `@/lib/*` and `next/server` imports rewired. */
export async function importDoh() {
  return importTypeScript(
    "../src/lib/doh.ts",
    new URL("../", import.meta.url),
    {
      "next/server": nextServerUrl,
      "@/lib/providers": await libUrl("providers"),
      "@/lib/dns": await libUrl("dns"),
      "@/lib/client-ip": await libUrl("client-ip"),
      "@/lib/upstreams": await libUrl("upstreams"),
    },
    "doh.ts",
  );
}
