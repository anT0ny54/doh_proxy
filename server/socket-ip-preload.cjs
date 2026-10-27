"use strict";
/**
 * Loaded with `node --require` before the server starts:
 *   node --require ./socket-ip-preload.cjs server.js        (Docker image)
 *   npm start                                               (next start)
 *
 * 1. Records the TCP peer address of every HTTP request in a private header so
 *    the rate limiter can identify clients without trusting forwarding headers
 *    (TRUST_PROXY_HEADERS=0), decide whether the peer is a trusted proxy
 *    (TRUSTED_PROXIES), and fall back to it when trusted headers are absent.
 *    The header is overwritten on every request, so a client cannot forge it.
 *    src/lib/client-ip.ts honours it only when the globalThis flag below is
 *    set, i.e. only in processes that actually loaded this file.
 *
 * 2. Bounds slow clients at the transport level. Next.js buffers the whole
 *    request body before src/proxy.ts and the route run, so the route's 1 s
 *    body deadline cannot see a slow upload; Node's own defaults (300 s
 *    request timeout, checked every 30 s) would let one connection trickle a
 *    body for minutes. Servers created with http.createServer() therefore get
 *    tighter defaults (Node answers 408 itself when they expire). Explicit
 *    options passed by the caller still win.
 *
 * 3. Keeps oversized bodies detectable. next.config.ts caps the body Next.js
 *    buffers at proxyClientMaxBodySize (4097 bytes), but Next.js drops the
 *    whole chunk that crosses the cap, so a large chunked upload could reach
 *    the route as a short, valid-looking prefix. Splitting the crossing chunk
 *    exactly at the cap makes the route always see 4097 bytes and answer 413.
 *    The bytes are unchanged; only chunk boundaries move.
 *
 * Keep HEADER and FLAG in sync with src/lib/config.ts and BODY_CAP_BYTES in
 * sync with next.config.ts (checked by scripts/test-config.mjs).
 */
const http = require("node:http");

const HEADER = "x-doh-socket-ip";
const FLAG = "__dohSocketIpPreload";

/** Whole request (headers + body) must arrive within this many ms. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Request headers must arrive within this many ms. */
const HEADERS_TIMEOUT_MS = 5_000;
/** How often Node checks the two timeouts above (default 30 s). */
const CONNECTIONS_CHECKING_INTERVAL_MS = 1_000;
/** experimental.proxyClientMaxBodySize in next.config.ts. */
const BODY_CAP_BYTES = 4_097;

/** Splits the body chunk that crosses BODY_CAP_BYTES at exactly that offset. */
function splitBodyAtCap(request) {
  const push = request.push;
  let received = 0;
  request.push = function pushSplitAtCap(chunk, encoding) {
    if (received < BODY_CAP_BYTES && Buffer.isBuffer(chunk) && received + chunk.length > BODY_CAP_BYTES) {
      const head = BODY_CAP_BYTES - received;
      received += chunk.length;
      push.call(this, chunk.subarray(0, head));
      return push.call(this, chunk.subarray(head));
    }
    if (Buffer.isBuffer(chunk)) received += chunk.length;
    return push.call(this, chunk, encoding);
  };
}

if (globalThis[FLAG] !== true) {
  globalThis[FLAG] = true;

  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emitWithSocketIp(event, ...args) {
    const request = args[0];
    if (event === "request" && request && request.headers) {
      const address = request.socket && request.socket.remoteAddress;
      if (address) request.headers[HEADER] = address;
      else delete request.headers[HEADER];
      if (request.method === "POST") splitBodyAtCap(request);
    }
    // Preserve the original event argument list for every event. In particular,
    // `listening` and `close` are emitted without arguments by Node.js.
    return emit.call(this, event, ...args);
  };

  const createServer = http.createServer;
  http.createServer = function createServerWithTimeouts(options, listener) {
    if (typeof options === "function") {
      listener = options;
      options = {};
    } else if (options === undefined || options === null) {
      // Keep a second-argument listener intact for createServer(undefined, fn).
      options = {};
    }
    const merged = {
      ...options,
      // An own property whose value is undefined still overrides the defaults
      // during a spread. Normalize the three managed timeout options so explicit
      // undefined behaves exactly like an absent option (null remains an invalid
      // caller-supplied value and is intentionally passed through).
      requestTimeout: options.requestTimeout ?? REQUEST_TIMEOUT_MS,
      headersTimeout: options.headersTimeout ?? HEADERS_TIMEOUT_MS,
      connectionsCheckingInterval: options.connectionsCheckingInterval ?? CONNECTIONS_CHECKING_INTERVAL_MS,
    };
    // Node requires headersTimeout <= requestTimeout (0 disables the latter).
    if (merged.requestTimeout > 0) {
      merged.headersTimeout = Math.min(merged.headersTimeout, merged.requestTimeout);
    }
    return createServer.call(this, merged, listener);
  };
}
