import { NextRequest } from "next/server";
import { handleDoH } from "@/lib/doh";

export const runtime = "edge";

interface RouteContext {
  params: Promise<{ provider: string; format: string }>;
}

async function route(request: NextRequest, { params }: RouteContext) {
  const { provider, format } = await params;
  return handleDoH(request, provider, format);
}

export const GET = route;
export const POST = route;
export const HEAD = route;
export const OPTIONS = route;
