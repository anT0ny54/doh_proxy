import { NextRequest } from "next/server";
import { handleHageziDoH } from "@/lib/doh";

export const runtime = "nodejs";
export const maxDuration = 5;

const route = (request: NextRequest) => handleHageziDoH(request);

export const GET = route;
export const POST = route;
export const HEAD = route;
export const OPTIONS = route;
