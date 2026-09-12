import { NextRequest, NextResponse } from "next/server";
import { getProvider, resolveProviderEndpoint } from "@/lib/providers";

const REQUEST_TIMEOUT_MS = 3_000;
const MAX_QUERY_STRING_LENGTH = 1_024;
const MAX_BODY_SIZE = 4_096;
const PROXY_VERSION = "v2.3.0";
const DEFAULT_JSON_ACCEPT = "application/dns-json";
const DEFAULT_WIRE_ACCEPT = "application/dns-message";
const USER_AGENT = `DoH-Proxy/${PROXY_VERSION.slice(1)}`;
const DOMAIN_LABEL = /^[A-Za-z0-9-]+$/;
const DNS_MESSAGE = /^[A-Za-z0-9_-]+={0,2}$/;

interface LogEntry {
  timestamp: string;
  provider: string;
  durationMs: number;
  status: number;
  method: string;
  error?: string;
}

const TYPE_TO_CODE: Record<string, number> = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28,
  SRV: 33, CAA: 257,
};
const CODE_TO_TYPE: Record<number, string> = Object.fromEntries(
  Object.entries(TYPE_TO_CODE).map(([name, code]) => [code, name]),
);

function baseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    Vary: "Accept, Accept-Encoding, Origin",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Content-Length",
    "X-DoH-Proxy-Version": PROXY_VERSION,
  });
}

function response(body: BodyInit | null, status: number, contentType = "text/plain; charset=utf-8"): NextResponse {
  const headers = baseHeaders();
  if (contentType) headers.set("Content-Type", contentType);
  return new NextResponse(body, { status, headers });
}

function logRequest(entry: LogEntry): void {
  if (process.env.DEBUG_LOG === "true" || entry.status >= 400) console.log(JSON.stringify(entry));
}

function isValidDomainName(value: string): boolean {
  if (value === ".") return true;
  if (value.length === 0 || value.length > 253) return false;
  const normalized = value.endsWith(".") ? value.slice(0, -1) : value;
  return normalized.split(".").every((label) =>
    label.length > 0 && label.length <= 63 && DOMAIN_LABEL.test(label) &&
    !label.startsWith("-") && !label.endsWith("-"),
  );
}

function validateRequest(url: URL, method: string): NextResponse | null {
  if (url.search.length > MAX_QUERY_STRING_LENGTH) return response("Query string too long", 414);
  if (method === "OPTIONS" || method === "HEAD" || method === "POST") return null;
  if (method !== "GET") return response("Method not allowed", 405);

  const dns = url.searchParams.get("dns");
  if (dns !== null) {
    if (!dns || dns.length > MAX_QUERY_STRING_LENGTH || !DNS_MESSAGE.test(dns)) {
      return response("Invalid DNS message parameter", 400);
    }
    return null;
  }

  const name = url.searchParams.get("name");
  if (!name || !isValidDomainName(name)) return response("Invalid domain name", 400);
  return null;
}

function makeDnsQuery(name: string, type: number): Uint8Array {
  const labels = name.replace(/\.$/, "").split(".");
  const qname: number[] = [];
  for (const label of labels) {
    const bytes = new TextEncoder().encode(label);
    qname.push(bytes.length, ...bytes);
  }
  qname.push(0);
  const out = new Uint8Array(12 + qname.length + 4);
  const view = new DataView(out.buffer);
  view.setUint16(0, Math.floor(Math.random() * 65536));
  view.setUint16(2, 0x0100); // RD
  view.setUint16(4, 1); // QDCOUNT
  out.set(qname, 12);
  view.setUint16(12 + qname.length, type);
  view.setUint16(14 + qname.length, 1); // IN
  return out;
}

function readName(bytes: Uint8Array, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = start;
  let next = start;
  let jumped = false;
  let guard = 0;
  while (pos < bytes.length && guard++ < 128) {
    const len = bytes[pos];
    if (len === 0) {
      if (!jumped) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= bytes.length) throw new Error("Invalid DNS name pointer");
      const target = ((len & 0x3f) << 8) | bytes[pos + 1];
      if (!jumped) next = pos + 2;
      pos = target;
      jumped = true;
      continue;
    }
    if (len > 63 || pos + 1 + len > bytes.length) throw new Error("Invalid DNS label");
    labels.push(new TextDecoder().decode(bytes.slice(pos + 1, pos + 1 + len)));
    pos += 1 + len;
    if (!jumped) next = pos;
  }
  if (guard >= 128) throw new Error("DNS name pointer loop");
  return { name: labels.length ? `${labels.join(".")}.` : ".", next };
}

function readU16(view: DataView, offset: number): number { return view.getUint16(offset, false); }
function readU32(view: DataView, offset: number): number { return view.getUint32(offset, false); }

function decodeRdata(type: number, bytes: Uint8Array, rdataStart: number, rdlength: number): string {
  const end = rdataStart + rdlength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (type) {
    case 1:
      if (rdlength !== 4) return `\\# ${rdlength} ${Array.from(bytes.slice(rdataStart, end)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      return Array.from(bytes.slice(rdataStart, end)).join(".");
    case 28:
      if (rdlength !== 16) break;
      return Array.from({ length: 8 }, (_, i) => readU16(view, rdataStart + i * 2).toString(16)).join(":");
    case 2:
    case 5:
    case 12:
      return readName(bytes, rdataStart).name;
    case 15: {
      if (rdlength < 3) break;
      const preference = readU16(view, rdataStart);
      return `${preference} ${readName(bytes, rdataStart + 2).name}`;
    }
    case 6: {
      let p = rdataStart;
      const mname = readName(bytes, p); p = mname.next;
      const rname = readName(bytes, p); p = rname.next;
      if (p + 20 > end) break;
      return `${mname.name} ${rname.name} ${readU32(view, p)} ${readU32(view, p + 4)} ${readU32(view, p + 8)} ${readU32(view, p + 12)} ${readU32(view, p + 16)}`;
    }
    case 16: {
      const parts: string[] = [];
      let p = rdataStart;
      while (p < end) {
        const len = bytes[p++];
        if (p + len > end) break;
        parts.push(`"${new TextDecoder().decode(bytes.slice(p, p + len)).replaceAll('"', '\\"')}"`);
        p += len;
      }
      return parts.join(" ");
    }
    case 33: {
      if (rdlength < 7) break;
      const priority = readU16(view, rdataStart);
      const weight = readU16(view, rdataStart + 2);
      const port = readU16(view, rdataStart + 4);
      return `${priority} ${weight} ${port} ${readName(bytes, rdataStart + 6).name}`;
    }
    case 257: {
      return new TextDecoder().decode(bytes.slice(rdataStart, end));
    }
  }
  return `\\# ${rdlength} ${Array.from(bytes.slice(rdataStart, end)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function wireToJson(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length < 12) throw new Error("Invalid DNS response");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = readU16(view, 2);
  const qd = readU16(view, 4), an = readU16(view, 6), ns = readU16(view, 8), ar = readU16(view, 10);
  let pos = 12;
  const Question: Array<{ name: string; type: number }> = [];
  for (let i = 0; i < qd; i++) {
    const q = readName(bytes, pos); pos = q.next;
    if (pos + 4 > bytes.length) throw new Error("Invalid DNS question");
    const type = readU16(view, pos); pos += 4;
    Question.push({ name: q.name, type });
  }
  function records(count: number) {
    const result: Array<{ name: string; type: number; TTL: number; data: string }> = [];
    for (let i = 0; i < count; i++) {
      const owner = readName(bytes, pos); pos = owner.next;
      if (pos + 10 > bytes.length) throw new Error("Invalid DNS record");
      const type = readU16(view, pos); const ttl = readU32(view, pos + 4); const rdlength = readU16(view, pos + 8);
      const rdataStart = pos + 10;
      if (rdataStart + rdlength > bytes.length) throw new Error("Invalid DNS RDATA");
      const data = decodeRdata(type, bytes, rdataStart, rdlength);
      pos = rdataStart + rdlength;
      result.push({ name: owner.name, type, TTL: ttl, data });
    }
    return result;
  }
  const rcode = flags & 0x000f;
  return {
    Status: rcode,
    TC: Boolean(flags & 0x0200),
    RD: Boolean(flags & 0x0100),
    RA: Boolean(flags & 0x0080),
    AD: Boolean(flags & 0x0020),
    CD: Boolean(flags & 0x0010),
    Question,
    ...(an ? { Answer: records(an) } : {}),
    ...(ns ? { Authority: records(ns) } : {}),
    ...(ar ? { Additional: records(ar) } : {}),
  };
}

async function dnsSbJson(name: string, typeParam: string, cd: string | null, dnssec: string | null): Promise<NextResponse> {
  const type = Number(typeParam) || TYPE_TO_CODE[typeParam.toUpperCase()] || 1;
  const body = makeDnsQuery(name, type);
  // Next.js 16 / TypeScript 5 DOM typings require a concrete ArrayBuffer for
  // fetch() request bodies. Copy the query into a real ArrayBuffer rather than
  // passing Uint8Array<ArrayBufferLike> directly.
  const queryBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(queryBuffer).set(body);
  const upstream = new URL("https://doh.dns.sb/dns-query");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const result = await fetch(upstream, {
      method: "POST",
      headers: { Accept: DEFAULT_WIRE_ACCEPT, "Content-Type": DEFAULT_WIRE_ACCEPT, "User-Agent": USER_AGENT },
      body: queryBuffer,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!result.ok) return response(JSON.stringify({ error: `DNS.SB HTTP ${result.status}` }), result.status, "application/json; charset=utf-8");
    const raw = new Uint8Array(await result.arrayBuffer());
    const json = wireToJson(raw);
    if (cd !== null) (json as Record<string, unknown>).CD = /^(1|true)$/i.test(cd);
    if (dnssec !== null) (json as Record<string, unknown>).DO = /^(1|true)$/i.test(dnssec);
    return response(JSON.stringify(json), 200, "application/dns-json; charset=utf-8");
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveUpstream(providerId: string, formatSegment?: string): string | NextResponse {
  const provider = getProvider(providerId);
  if (!provider) return response(`Provider '${providerId}' not found`, 404);
  const endpoint = resolveProviderEndpoint(provider, formatSegment);
  if (!endpoint) return response(`Endpoint '${formatSegment}' not found for provider '${providerId}'`, 404);
  return endpoint;
}

function acceptHeader(request: NextRequest, providerId: string, formatSegment: string | undefined, url: URL): string {
  if (formatSegment === "dns-query") return DEFAULT_WIRE_ACCEPT;
  if (request.method === "GET" && !url.searchParams.has("dns")) return DEFAULT_JSON_ACCEPT;
  return request.headers.get("accept") || DEFAULT_WIRE_ACCEPT;
}

async function readBody(request: NextRequest): Promise<ArrayBuffer | NextResponse> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isFinite(size) || size < 0 || size > MAX_BODY_SIZE) return response("Payload too large", 413);
  }
  const body = await request.arrayBuffer();
  if (!body.byteLength) return response("Empty DNS request body", 400);
  if (body.byteLength > MAX_BODY_SIZE) return response("Payload too large", 413);
  return body;
}

export async function handleDoH(request: NextRequest, providerId: string, formatSegment?: string): Promise<NextResponse> {
  const startedAt = Date.now();
  let status = 500;
  let error: string | undefined;
  try {
    if (request.method === "OPTIONS" || request.method === "HEAD") return response(null, 204, "");
    const url = new URL(request.url);
    const validationError = validateRequest(url, request.method);
    if (validationError) {
      status = validationError.status;
      if (status === 405) validationError.headers.set("Allow", "GET, POST, HEAD, OPTIONS");
      return validationError;
    }

    if (providerId === "dnssb" && (!formatSegment || formatSegment === "resolve") && request.method === "GET" && !url.searchParams.has("dns")) {
      status = 200;
      return await dnsSbJson(
        url.searchParams.get("name") || "",
        url.searchParams.get("type") || "A",
        url.searchParams.get("cd"),
        url.searchParams.get("do"),
      );
    }

    if (request.method === "POST" && formatSegment !== "dns-query" && providerId !== "cloudflare") {
      status = 405;
      const result = response("POST is only supported on /dns-query for this provider", 405);
      result.headers.set("Allow", "GET, OPTIONS, HEAD");
      return result;
    }

    let body: ArrayBuffer | undefined;
    if (request.method === "POST") {
      const bodyResult = await readBody(request);
      if (bodyResult instanceof NextResponse) { status = bodyResult.status; return bodyResult; }
      body = bodyResult;
    }

    const upstreamResult = resolveUpstream(providerId, formatSegment);
    if (upstreamResult instanceof NextResponse) { status = upstreamResult.status; return upstreamResult; }
    const upstreamUrl = new URL(upstreamResult);
    if (request.method === "GET") {
      for (const [key, value] of url.searchParams) upstreamUrl.searchParams.append(key, value);
    }

    const headers = new Headers({ Accept: acceptHeader(request, providerId, formatSegment, url), "User-Agent": USER_AGENT });
    if (request.method === "POST") headers.set("Content-Type", request.headers.get("content-type") || DEFAULT_WIRE_ACCEPT);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, { method: request.method, headers, body, signal: controller.signal, cache: "no-store" });
    } finally { clearTimeout(timeoutId); }

    status = upstreamResponse.status;
    const responseHeaders = baseHeaders();
    responseHeaders.set("Content-Type", upstreamResponse.headers.get("content-type") || (formatSegment === "dns-query" ? DEFAULT_WIRE_ACCEPT : DEFAULT_JSON_ACCEPT));
    return new NextResponse(upstreamResponse.body, { status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers: responseHeaders });
  } catch (caught: unknown) {
    const timeout = caught instanceof Error && caught.name === "AbortError";
    status = timeout ? 504 : 502;
    error = timeout ? "Upstream Timeout" : "Upstream Connection Failed";
    return response(JSON.stringify({ error }), status, "application/json; charset=utf-8");
  } finally {
    logRequest({ timestamp: new Date().toISOString(), provider: providerId, durationMs: Date.now() - startedAt, status, method: request.method, error });
  }
}
