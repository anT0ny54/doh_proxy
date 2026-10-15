import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Node globals for the node:test suites and build/test helpers under scripts/.
// Listed explicitly so the repo does not need the `globals` package.
const nodeGlobals = {
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  fetch: "readonly",
  console: "readonly",
  process: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  queueMicrotask: "readonly",
  structuredClone: "readonly",
  globalThis: "readonly",
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // Test suites and helpers are linted too (previously excluded via a blanket
  // scripts/** ignore); they only need Node runtime globals on top of the
  // shared config.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
