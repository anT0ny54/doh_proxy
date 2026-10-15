/**
 * Docker container smoke test, shared by .github/workflows/ci.yml and
 * .github/workflows/docker-publish.yml.
 *
 * Usage: node scripts/docker-smoke-test.mjs <image> [timeoutSeconds=60]
 *
 * Starts the local mock upstream, runs <image> on the host network with
 * HAGEZI_UPSTREAM_ENDPOINTS pointing at it, and sends a real DoH GET. The test
 * passes only on `200 application/dns-message`, so a broken standalone bundle
 * or a missing socket-IP preload fails here (not just "the home page loads").
 * The container and the mock are always cleaned up, whatever the outcome; a
 * stale container with the same name from an interrupted run is removed first.
 */
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { DNS_MESSAGE, validQuery } from "./lib/dns-fixtures.mjs";
import { startMockUpstream } from "./lib/mock-upstream.mjs";

const MOCK_PORT = 18053;
const APP_PORT = 18367;
const CONTAINER = "doh-proxy";
const EXPECTED = `200 ${DNS_MESSAGE}`;

const image = process.argv[2];
const timeoutSeconds = Number(process.argv[3] ?? 60);
if (!image || !(timeoutSeconds > 0)) {
  console.error("usage: node scripts/docker-smoke-test.mjs <image> [timeoutSeconds=60]");
  process.exit(2);
}

const docker = (...args) => spawnSync("docker", args, { stdio: "inherit" });

const url = `http://127.0.0.1:${APP_PORT}/api/doh/dns-query?dns=${Buffer.from(validQuery()).toString("base64url")}`;
const mock = await startMockUpstream(MOCK_PORT);
let started = false;
let result = "no response";

try {
  // A container left over from an interrupted run would make `docker run` fail
  // on the name clash, and the failure would be misreported as a broken image.
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  started =
    docker(
      "run", "-d", "--name", CONTAINER, "--network", "host",
      "-e", `PORT=${APP_PORT}`,
      "-e", `HAGEZI_UPSTREAM_ENDPOINTS=http://127.0.0.1:${MOCK_PORT}/dns-query`,
      image,
    ).status === 0;

  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (started && result !== EXPECTED && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      await response.arrayBuffer();
      result = `${response.status} ${response.headers.get("content-type")}`;
    } catch (error) {
      result = String(error?.cause?.code ?? error?.message ?? error);
    }
    if (result !== EXPECTED) await delay(1_000);
  }
} finally {
  if (started) docker("logs", CONTAINER);
  docker("rm", "-f", CONTAINER);
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
}

if (result !== EXPECTED) {
  console.error(`Container did not answer a DoH query (got: ${started ? result : "docker run failed"})`);
  process.exit(1);
}
console.log(`Container answered a DoH query (${result})`);
process.exit(0);
