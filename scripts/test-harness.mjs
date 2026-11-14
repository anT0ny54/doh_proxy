import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startMockUpstream } from "./lib/mock-upstream.mjs";

test("mock upstream rejects promptly when its requested port is already occupied", async () => {
  const occupied = http.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = occupied.address();
    await assert.rejects(startMockUpstream(port), { code: "EADDRINUSE" });
  } finally {
    await new Promise((resolve, reject) => {
      occupied.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("Docker smoke test rejects invalid readiness deadlines before invoking Docker", () => {
  const script = fileURLToPath(new URL("./docker-smoke-test.mjs", import.meta.url));
  for (const timeout of ["Infinity", "1e308", "1e-6"]) {
    const result = spawnSync(process.execPath, [script, "test-image", timeout], {
      encoding: "utf8",
      timeout: 3_000, // Fail promptly if invalid input ever reaches Docker startup.
      env: { ...process.env, PATH: "" }, // Never invoke a real Docker CLI if validation regresses.
    });
    assert.equal(result.status, 2, `timeout ${timeout}`);
    assert.match(result.stderr, /usage: node scripts\/docker-smoke-test\.mjs/);
  }
});
