import { NextRequest } from "next/server";
import { handleDoH } from "@/lib/doh";

export const runtime = "edge";

interface RouteContext {
  params: Promise<{ segments: string[] }>;
}

async function dispatch(request: NextRequest, { params }: RouteContext) {
  const segments = await params;
  const [providerId, formatSegment] = segments.segments ?? [];

  if (!providerId || segments.segments.length > 2) {
    return new Response("Invalid DoH route", { status: 404 });
  }

  return handleDoH(request, providerId, formatSegment);
}

export async function GET(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}

export async function HEAD(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}

export async function OPTIONS(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}
  
