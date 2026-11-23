import type { Db } from "../database/db";
import { addAudit, getSettings } from "../database/repo";
import { fetchTopology } from "../server/topology";
import { Pseudonymiser } from "./pseudonym";

/**
 * Decides whether what goes to the model is pseudonymised for this network, and if so builds the mapper with every
 * device and network name already registered. Returns null when masking is off for this network.
 * When the environment cannot be determined it is treated as production: masking is the safe side to err on.
 */
export async function pseudonymiserFor(db: Db, scopeId: string | null, extraNames: (string | null | undefined)[] = []): Promise<Pseudonymiser | null> {
  const { llmPrivacy: mode, llmPrivateTerms: terms, llmSafeWords: safeWords } = getSettings(db);
  if (mode === "off") return null;
  const devices: string[] = [];
  const networks = extraNames.filter((n): n is string => !!n);
  let production = true;
  if (scopeId) {
    try {
      const t = await fetchTopology(scopeId);
      production = t.lab.environment === "production";
      devices.push(...t.nodes.map((n) => n.label));
      networks.push(t.lab.title, scopeId);
    } catch {
      /* without the topology only what the text itself declares (hostname lines) can be learned */
    }
  }
  if (mode === "production" && !production) return null;
  return new Pseudonymiser({ devices, networks, terms, safeWords });
}

/** Records, without any content, what a model request did or did not mask, so the choice can be reviewed later. */
export function auditPrivacy(db: Db, what: string, p: Pseudonymiser | null, scopeId: string | null): void {
  addAudit(db, {
    kind: "claude",
    actor: "system",
    summary: p ? `${what}: sent to the AI model with identifying data replaced (${p.describe()})` : `${what}: sent to the AI model without masking`,
    data: { scopeId, pseudonymised: !!p, ...(p ? p.stats : {}) },
  });
}
