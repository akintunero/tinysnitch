"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { LabSummary } from "@/lib/cml/labs";
import { apiGet, apiSend } from "@/lib/client";
import type { Settings } from "@/lib/settings";

export type Status = {
  mcp: {
    configured: boolean; configError: string | null;
    status: "disconnected" | "connecting" | "connected" | "error";
    transport: string | null; endpoint: string | null; server: { name: string; version: string } | null;
    toolCount: number; lastAttempt: string | null; lastError: string | null;
  };
  claude: {
    configured: boolean; model: string | null; configError: string | null;
    verification: "unverified" | "ok" | "error"; checkedAt: string | null; error: string | null;
  };
};

export type LabsState = {
  labs: LabSummary[]; totals: { labs: number; running: number; nodes: number; links: number } | null;
  error: string | null; loading: boolean; warnings: string[];
};

type Value = {
  status: Status | null; statusError: string | null; settings: Settings | null; labs: LabsState;
  refreshStatus: () => Promise<void>; refreshLabs: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  selectLab: (id: string | null) => Promise<void>;
};

const StatusCtx = createContext<Value | null>(null);

export function useApp(): Value {
  const v = useContext(StatusCtx);
  if (!v) throw new Error("useApp must be used inside StatusProvider");
  return v;
}

export function StatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [labs, setLabs] = useState<LabsState>({ labs: [], totals: null, error: null, loading: false, warnings: [] });
  const wasConnected = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await apiGet<Status>("/api/status"));
      setStatusError(null);
    } catch (e) {
      setStatusError((e as Error).message);
    }
  }, []);

  const refreshLabs = useCallback(async () => {
    setLabs((l) => ({ ...l, loading: true }));
    try {
      const r = await apiGet<{ labs: LabSummary[]; totals: LabsState["totals"]; warnings?: string[] }>("/api/labs");
      setLabs({ labs: r.labs, totals: r.totals, error: null, loading: false, warnings: r.warnings ?? [] });
    } catch (e) {
      setLabs({ labs: [], totals: null, error: (e as Error).message, loading: false, warnings: [] });
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    apiGet<Settings>("/api/settings").then(setSettings).catch(() => undefined);
    const id = setInterval(refreshStatus, 10_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Networks come from every configured source (CML, an inventory file, NetBox), so they load at once and again
  // whenever the CML connection changes, not only when CML connects.
  const connected = status?.mcp.status === "connected";
  useEffect(() => {
    if (connected !== wasConnected.current) void refreshLabs();
    wasConnected.current = connected;
  }, [connected, refreshLabs]);
  useEffect(() => { void refreshLabs(); }, [refreshLabs]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await apiSend<Settings>("PUT", "/api/settings", patch));
  }, []);

  const selectLab = useCallback(async (id: string | null) => {
    const r = await apiSend<{ selectedLabId: string | null; selectedLabTitle: string | null }>("POST", "/api/labs/select", { id });
    setSettings((s) => (s ? { ...s, ...r } : s));
  }, []);

  const value = useMemo(
    () => ({ status, statusError, settings, labs, refreshStatus, refreshLabs, updateSettings, selectLab }),
    [status, statusError, settings, labs, refreshStatus, refreshLabs, updateSettings, selectLab],
  );
  return <StatusCtx.Provider value={value}>{children}</StatusCtx.Provider>;
}

export const mcpTone = (s: Status["mcp"]["status"] | undefined) =>
  s === "connected" ? "ok" : s === "connecting" ? "warn" : s === "error" ? "bad" : "idle";
export const claudeTone = (c: Status["claude"] | undefined) =>
  !c || !c.configured ? "idle" : c.verification === "ok" ? "ok" : c.verification === "error" ? "bad" : "warn";
export const claudeLabel = (c: Status["claude"] | undefined) =>
  !c ? "checking" : !c.configured ? "not configured" : c.verification === "ok" ? "verified" : c.verification === "error" ? "error" : "configured";
