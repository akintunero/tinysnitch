import { listAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? 200);
  const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 500) : 200;
  return json({ events: listAudit(getContext().db, limit) });
});
