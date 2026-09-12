import { NextRequest } from "next/server";
import { handleDoH } from "@/lib/doh";

export const runtime = "edge";

interface RouteContext {
  params: Promise<{ provider: string; format: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { provider, format } = await params;
  return handleDoH(request, provider, format);
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { provider, format } = await params;
  return handleDoH(request, provider, format);
}

export async function HEAD(request: NextRequest, { params }: RouteContext) {
  const { provider, format } = await params;
  return handleDoH(request, provider, format);
}

export async function OPTIONS(request: NextRequest, { params }: RouteContext) {
  const { provider, format } = await params;
  return handleDoH(request, provider, format);
}
