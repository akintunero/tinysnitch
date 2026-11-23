import { catalogForClient } from "@/lib/provisioning/catalog";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** The services that can be provisioned from a form, with the fields each one asks for. */
export const GET = route(async () => json({ services: catalogForClient() }));
