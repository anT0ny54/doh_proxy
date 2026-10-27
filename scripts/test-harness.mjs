import assert from "node:assert/strict";
import http from "node:http";
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
