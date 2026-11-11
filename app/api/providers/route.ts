import { getProviders, providerProblems } from "@/lib/providers/registry";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Which network sources are configured, and why any that were meant to be are not working. No credentials. */
export const GET = route(async () => {
  const providers = getProviders().map((p) => ({ id: p.id, kind: p.kind, label: p.label }));
  return json({
    providers,
    problems: providerProblems.map((p) => ({ provider: p.provider, message: p.message })),
    configured: {
      cml: providers.some((p) => p.kind === "cml"),
      inventoryFile: Boolean(process.env.TS_INVENTORY_FILE?.trim()),
      netbox: Boolean(process.env.NETBOX_URL?.trim()),
    },
  });
});
