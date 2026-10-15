"use strict";
/**
 * Records the TCP peer address of every HTTP request in a private header so
 * the rate limiter can identify clients without trusting forwarding headers
 * (TRUST_PROXY_HEADERS=0), and as a fallback when trusted headers are absent.
 *
 * Load it before the server starts:
 *   node --require ./socket-ip-preload.cjs server.js        (Docker image)
 *   npm start                                               (next start)
 *
 * The header is overwritten on every request, so a client cannot forge it.
 * src/lib/client-ip.ts honours it only when the globalThis flag below is set,
 * i.e. only in processes that actually loaded this file.
 *
 * Keep HEADER and FLAG in sync with src/lib/config.ts.
 */
const http = require("node:http");

const HEADER = "x-doh-socket-ip";
const FLAG = "__dohSocketIpPreload";

if (globalThis[FLAG] !== true) {
  globalThis[FLAG] = true;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emitWithSocketIp(event, request, ...rest) {
    if (event === "request" && request && request.headers) {
      const address = request.socket && request.socket.remoteAddress;
      if (address) request.headers[HEADER] = address;
      else delete request.headers[HEADER];
    }
    return emit.call(this, event, request, ...rest);
  };
}
