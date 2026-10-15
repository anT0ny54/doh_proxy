import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// scripts/** (node:test suites and helpers) and server/** are linted with the
// shared config; it already provides the Node/browser globals they use.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // CommonJS preload loaded with `node --require`.
    files: ["server/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
