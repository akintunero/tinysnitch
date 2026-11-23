import { openApiDocument } from "@/lib/api/openapi";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** The OpenAPI description of /api/v1, for generating clients and for reading. */
export const GET = route(async (req) => {
  // The address the caller used, so a generated client points at the right server (behind a proxy, its forwarded scheme).
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return json(openApiDocument(`${proto}://${host}`));
});
