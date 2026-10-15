/**
 * Local mock DoH upstream shared by the integration suite and the CI Docker
 * smoke test. It answers every GET/POST query with a matching A record and
 * `Cache-Control: max-age=120`.
 *
 * CLI: node scripts/lib/mock-upstream.mjs <port>
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { DNS_MESSAGE, validResponse } from "./dns-fixtures.mjs";

export function startMockUpstream(port = 0, host = "127.0.0.1") {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const query =
        req.method === "GET" ? Buffer.from(url.searchParams.get("dns") ?? "", "base64url") : Buffer.concat(chunks);
      res.writeHead(200, { "content-type": DNS_MESSAGE, "cache-control": "max-age=120" });
      res.end(Buffer.from(validResponse(query)));
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startMockUpstream(Number(process.argv[2] ?? 0));
  console.log(`mock DoH upstream listening on 127.0.0.1:${server.address().port}`);
}
