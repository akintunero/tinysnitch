import { json, route } from "@/lib/server/http";
import { verifyClaude } from "@/lib/server/context";

export const dynamic = "force-dynamic";

/** A one-token request to confirm the key and model work. Only runs when the user asks. */
export const POST = route(async () => {
  const c = await verifyClaude();
  return json(c, c.verification === "ok" ? 200 : 502);
}, { write: true });
