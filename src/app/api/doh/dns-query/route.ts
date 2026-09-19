import { NextRequest } from "next/server";
import { handleHageziDoH } from "@/lib/doh";

export const dynamic = "force-dynamic";
export const runtime = "edge";

export const GET = (request: NextRequest) => handleHageziDoH(request);
export const POST = (request: NextRequest) => handleHageziDoH(request);
export const OPTIONS = (request: NextRequest) => handleHageziDoH(request);
export const HEAD = (request: NextRequest) => handleHageziDoH(request);
