"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { LabSummary } from "@/lib/cml/labs";
import { apiGet, apiSend } from "@/lib/client";
import { type Role, atLeast } from "@/lib/auth/roles";
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
    verification: "unverified" | "ok" | "error"; checkedAt: string | null; error: string | null; provider?: string | null; endpoint?: string | null;
  };
};

export type Session = {
  authEnabled: boolean; setupRequired: boolean; exposed: boolean;
  user: { username: string; role: Role; roleText: string } | null;
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
  session: Session | null; refreshSession: () => Promise<void>; signOut: () => Promise<void>;
  /** Whether the person using the app has at least this role. Everyone does while login is off. */
  can: (min: Role) => boolean;
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
  const [session, setSession] = useState<Session | null>(null);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await apiGet<Session>("/api/auth/session"));
    } catch {
      setSession(null);
    }
  }, []);
  useEffect(() => { void refreshSession(); }, [refreshSession]);
  // Any call that comes back 401 means the session ended (or login was turned on); find out which.
  useEffect(() => {
    const on = () => void refreshSession();
    window.addEventListener("ts-auth", on);
    return () => window.removeEventListener("ts-auth", on);
  }, [refreshSession]);

  /** The app has something to show once login is off, or on and someone is signed in. */
  const ready = session !== null && !session.setupRequired && (!session.authEnabled || session.user !== null);
  const who = session?.user?.username ?? "";

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
    if (!ready) return;
    void refreshStatus();
    apiGet<Settings>("/api/settings").then(setSettings).catch(() => undefined);
    const id = setInterval(refreshStatus, 10_000);
    return () => clearInterval(id);
  }, [ready, who, refreshStatus]);

  // Networks come from every configured source (CML, an inventory file, NetBox), so they load at once and again
  // whenever the CML connection changes, not only when CML connects.
  const connected = status?.mcp.status === "connected";
  useEffect(() => {
    if (ready && connected !== wasConnected.current) void refreshLabs();
    wasConnected.current = connected;
  }, [ready, connected, refreshLabs]);
  useEffect(() => { if (ready) void refreshLabs(); }, [ready, who, refreshLabs]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await apiSend<Settings>("PUT", "/api/settings", patch));
  }, []);

  const selectLab = useCallback(async (id: string | null) => {
    const r = await apiSend<{ selectedLabId: string | null; selectedLabTitle: string | null }>("POST", "/api/labs/select", { id });
    setSettings((s) => (s ? { ...s, ...r } : s));
  }, []);

  const signOut = useCallback(async () => {
    try { await apiSend("POST", "/api/auth/logout"); } catch { /* the session may already be gone */ }
    setSettings(null); setStatus(null);
    setLabs({ labs: [], totals: null, error: null, loading: false, warnings: [] });
    await refreshSession();
  }, [refreshSession]);

  const can = useCallback((min: Role) => !session?.authEnabled || (session.user !== null && atLeast(session.user.role, min)), [session]);

  const value = useMemo(
    () => ({ status, statusError, settings, labs, refreshStatus, refreshLabs, updateSettings, selectLab, session, refreshSession, signOut, can }),
    [status, statusError, settings, labs, refreshStatus, refreshLabs, updateSettings, selectLab, session, refreshSession, signOut, can],
  );
  return <StatusCtx.Provider value={value}>{children}</StatusCtx.Provider>;
}

export const mcpTone = (s: Status["mcp"]["status"] | undefined) =>
  s === "connected" ? "ok" : s === "connecting" ? "warn" : s === "error" ? "bad" : "idle";
export const claudeTone = (c: Status["claude"] | undefined) =>
  !c || !c.configured ? "idle" : c.verification === "ok" ? "ok" : c.verification === "error" ? "bad" : "idle";
export const claudeLabel = (c: Status["claude"] | undefined) =>
  !c ? "checking" : !c.configured ? "not configured" : c.verification === "ok" ? "verified" : c.verification === "error" ? "error" : "configured";
