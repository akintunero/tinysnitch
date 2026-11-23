import { GET as list, POST as create } from "@/app/api/services/route";
import { withIdempotency } from "@/lib/api/idempotency";

export const dynamic = "force-dynamic";
export const GET = list;
/** Provisions a service. Send an Idempotency-Key header to make a retry safe. */
export const POST = withIdempotency(create);
