import { NextRequest } from 'next/server';
import { handleDoH } from '@/lib/doh';

export const runtime = 'edge';

// Bare provider endpoint: /api/doh/<provider>
// (the upstream's default endpoint - see DOH_PROVIDERS.paths.default).

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  return handleDoH(request, provider);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  // RFC 8484 wire-format POST (Content-Type: application/dns-message).
  const { provider } = await params;
  return handleDoH(request, provider);
}

export async function HEAD(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  return handleDoH(request, provider);
}
