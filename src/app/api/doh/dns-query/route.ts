import { handleHageziDoH } from "@/lib/doh";

export const runtime = "nodejs";
export const maxDuration = 5;

export { handleHageziDoH as GET, handleHageziDoH as POST, handleHageziDoH as HEAD, handleHageziDoH as OPTIONS };
