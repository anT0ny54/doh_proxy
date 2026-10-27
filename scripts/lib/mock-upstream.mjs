/**
 * Local mock DoH upstream shared by the integration suite and the CI Docker
 * smoke test. It answers every GET/POST query with a matching A record and
 * `Cache-Control: max-age=120`.
 */
import http from "node:http";
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
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
