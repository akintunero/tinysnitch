import { GET as list, POST as propose } from "@/app/api/changes/route";
import { withIdempotency } from "@/lib/api/idempotency";

export const dynamic = "force-dynamic";
export const GET = list;
/** Files a proposal. Send an Idempotency-Key header to make a retry safe. */
export const POST = withIdempotency(propose);
