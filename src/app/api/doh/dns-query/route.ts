export const dynamic = "force-dynamic";
export const runtime = "edge";

// Upstream HaGeZi DoH Resolvers
const UPSTREAMS = [
  "https://root.hagezi.org/dns-query",
  "https://juuri.hagezi.org/dns-query",
  "https://wurzn.hagezi.org/dns-query",
] as const;

const UPSTREAM_TIMEOUT_MS = 2500;
const GLOBAL_TIMEOUT_MS = 3000;
const MAX_QUERY_PARAM_LENGTH = 1024;

type DoHResult = {
  body: ArrayBuffer;
  contentType: string;
};

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

async function queryUpstream(
  upstream: string,
  request: Request,
  requestBody: ArrayBuffer | undefined,
  parentSignal: AbortSignal
): Promise<DoHResult> {
  const clientUrl = new URL(request.url);
  const upstreamUrl = new URL(upstream);

  if (request.method === "GET") {
    upstreamUrl.search = clientUrl.search;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("Timeout"), UPSTREAM_TIMEOUT_MS);

  const onParentAbort = () => controller.abort("WinnerFound");

  if (parentSignal.aborted) {
    controller.abort("AlreadyAborted");
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  try {
    const headers: Record<string, string> = {
      Accept: request.headers.get("accept") || "application/dns-message",
      "User-Agent": request.headers.get("user-agent") || "DoH-Proxy/1.1",
    };

    if (request.method === "POST") {
      headers["Content-Type"] =
        request.headers.get("content-type") || "application/dns-message";
    }

    const response = await fetch(upstreamUrl.toString(), {
      method: request.method,
      headers,
      // Pass buffer slice to isolate concurrent arrayBuffer access safely
      body: request.method === "POST" && requestBody ? requestBody.slice(0) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${upstream} returned HTTP ${response.status}`);
    }

    const body = await response.arrayBuffer();

    return {
      body,
      contentType:
        response.headers.get("content-type") || "application/dns-message",
    };
  } finally {
    clearTimeout(timeoutId);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

async function handleDoH(request: Request): Promise<Response> {
  // 1. CORS Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // 2. Health Check
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // 3. Method Guard
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        ...corsHeaders,
        Allow: "GET, POST, OPTIONS, HEAD",
      },
    });
  }

  // 4. Input Validation
  const url = new URL(request.url);
  if (request.method === "GET") {
    if (!url.search || url.search.length > MAX_QUERY_PARAM_LENGTH) {
      return new Response("Bad Request: Missing or invalid query parameters", {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain",
        },
      });
    }
  }

  let requestBody: ArrayBuffer | undefined = undefined;
  if (request.method === "POST") {
    requestBody = await request.arrayBuffer();
    if (!requestBody || requestBody.byteLength === 0) {
      return new Response("Bad Request: Empty request body", {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain",
        },
      });
    }
  }

  // 5. Race Upstreams with Global Budget & Auto-Cancellation
  const cancelOthersController = new AbortController();
  const globalTimeoutId = setTimeout(
    () => cancelOthersController.abort("GlobalTimeout"),
    GLOBAL_TIMEOUT_MS
  );

  try {
    const upstreamRequests = UPSTREAMS.map((upstream) =>
      queryUpstream(upstream, request, requestBody, cancelOthersController.signal)
    );

    const result = await Promise.any(upstreamRequests);

    // Cancel remaining pending upstream requests
    cancelOthersController.abort("RaceResolved");

    return new Response(result.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": result.contentType,
      },
    });
  } catch {
    cancelOthersController.abort("AllFailed");

    return new Response("All DNS upstreams failed or timed out", {
      status: 502,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/plain",
      },
    });
  } finally {
    clearTimeout(globalTimeoutId);
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleDoH(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleDoH(request);
}

export async function OPTIONS(request: Request): Promise<Response> {
  return handleDoH(request);
}

export async function HEAD(request: Request): Promise<Response> {
  return handleDoH(request);
}