import { NextRequest } from 'next/server';
import { handleDoH } from '@/lib/doh';

export const runtime = 'edge';

type RouteContext = {
  params: Promise<{
    provider: string;
  }>;
};

export async function GET(
  request: NextRequest,
  { params }: RouteContext
) {
  const { provider } = await params;
  return handleDoH(request, provider);
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
) {
  const { provider } = await params;
  return handleDoH(request, provider);
}

export async function HEAD(
  request: NextRequest,
  { params }: RouteContext
) {
  const { provider } = await params;
  return handleDoH(request, provider);
}

export async function OPTIONS(request: NextRequest) {
  return handleDoH(request, '');
}
