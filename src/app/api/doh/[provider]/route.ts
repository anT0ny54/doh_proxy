import { NextRequest } from "next/server";
import { handleDoH } from "@/lib/doh";

export const runtime = "edge";

interface RouteContext {
  params: Promise<{ provider: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  return handleDoH(request, (await params).provider);
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  return handleDoH(request, (await params).provider);
}

export async function HEAD(request: NextRequest, { params }: RouteContext) {
  return handleDoH(request, (await params).provider);
}

export function OPTIONS(request: NextRequest) {
  return handleDoH(request, "");
}
