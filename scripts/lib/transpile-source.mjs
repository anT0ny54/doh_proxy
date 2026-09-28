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
    source = source.replace(`from "${from}"`, `from "${to}"`);
  }
  return import(toDataUrl(source, filename));
}
