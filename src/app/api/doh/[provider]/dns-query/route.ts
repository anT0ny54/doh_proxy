import { NextRequest } from "next/server";
import { handleDoH } from "@/lib/doh";
import { DOH_PROVIDERS } from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 5;
// Only the compiled-in provider ids exist; the router answers 404 for any
// other id before handler code runs.
export const dynamicParams = false;

export function generateStaticParams() {
  return DOH_PROVIDERS.map((provider) => ({ provider: provider.id }));
}

interface RouteContext {
  params: Promise<{ provider: string }>;
}

async function route(request: NextRequest, { params }: RouteContext) {
  const { provider } = await params;
  return handleDoH(request, provider);
}

export { route as GET, route as POST, route as HEAD, route as OPTIONS };
