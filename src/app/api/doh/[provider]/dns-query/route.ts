import { NextRequest } from "next/server";
import { handleDoH } from "@/lib/doh";

export const runtime = "edge";
export const maxDuration = 5;

interface RouteContext {
  params: Promise<{ provider: string }>;
}

async function route(request: NextRequest, { params }: RouteContext) {
  const { provider } = await params;
  return handleDoH(request, provider);
}

export const GET = route;
export const POST = route;
export const HEAD = route;
export const OPTIONS = route;
