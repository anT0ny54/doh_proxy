export const dynamic = "force-dynamic";
export const runtime = "edge";

const UPSTREAMS = [
  "https://root.hagezi.org/dns-query",
  "https://juuri.hagezi.org/dns-query",
  "https://wurzn.hagezi.org/dns-query",
];

const TIMEOUT_MS = 3000;

type DoHResult = {
  body: ArrayBuffer;
  contentType: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Cache-Control": "no-store",
};

async function queryUpstream(
  upstream: string,
  request: Request,
  requestBody?: ArrayBuffer
): Promise<DoHResult> {
  const clientUrl = new URL(request.url);
  const upstreamUrl = new URL(upstream);

  if (request.method === "GET") {
    upstreamUrl.search = clientUrl.search;
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(upstreamUrl.toString(), {
      method: request.method,
      headers: {
        Accept:
          request.headers.get("accept") ||
          "application/dns-message",
        "Content-Type":
          request.headers.get("content-type") ||
          "application/dns-message",
      },
      body: request.method === "POST" ? requestBody : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `${upstream} returned HTTP ${response.status}`
      );
    }

    const body = await response.arrayBuffer();

    return {
      body,
      contentType:
        response.headers.get("content-type") ||
        "application/dns-message",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleDoH(request: Request): Promise<Response> {
  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        ...corsHeaders,
        Allow: "GET, POST, OPTIONS",
      },
    });
  }

  // A Request body can only be read once.
  const requestBody =
    request.method === "POST"
      ? await request.arrayBuffer()
      : undefined;

  const upstreamRequests = UPSTREAMS.map((upstream) =>
    queryUpstream(upstream, request, requestBody)
  );

  try {
    // Sends to every upstream at the same time and returns
    // the first successful response.
    const result = await Promise.any(upstreamRequests);

    return new Response(result.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": result.contentType,
      },
    });
  } catch {
    return new Response("All DNS upstreams failed", {
      status: 502,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/plain",
      },
    });
  }
}

export const GET = handleDoH;
export const POST = handleDoH;
export const OPTIONS = handleDoH;