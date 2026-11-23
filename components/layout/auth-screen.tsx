"use client";

import { useState } from "react";
import { useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import { apiSend } from "@/lib/client";

/**
 * Shown instead of the app when login is on and nobody is signed in, or when an install that listens beyond this
 * machine still has to create its first administrator.
 */
export function AuthScreen() {
  const { session, refreshSession } = useApp();
  const setup = session?.setupRequired ?? false;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiSend("POST", setup ? "/api/auth/setup" : "/api/auth/login", setup ? { username, password, ...(token ? { setupToken: token } : {}) } : { username, password });
      setPassword("");
      await refreshSession();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = "mt-0.5 block h-9 w-full rounded-sm border border-line bg-bg px-2.5 text-[14px]";
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm rounded-md border border-line bg-surface p-5">
        <h1 className="text-[17px] font-semibold tracking-tight">Tiny Snitch</h1>
        <p className="text-soft mb-4 text-[12px]">{setup ? "Create the first administrator to finish setting this up." : "Sign in to continue."}</p>
        {setup ? <p className="mb-3 rounded-sm border border-line bg-surface-2 px-2.5 py-2 text-[12px]">This install listens beyond this machine, so it is closed until an administrator exists. The setup token is <span className="font-mono">TS_SETUP_TOKEN</span>, or the one printed in the server&apos;s log when it started.</p> : null}
        <label className="block text-[12px]">Username
          <input className={field} autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={60} />
        </label>
        <label className="mt-3 block text-[12px]">Password{setup ? " (at least 12 characters)" : ""}
          <input className={field} type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={300} />
        </label>
        {setup && session?.exposed ? (
          <label className="mt-3 block text-[12px]">Setup token
            <input className={`${field} font-mono`} autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required maxLength={200} />
          </label>
        ) : null}
        {error ? <p role="alert" className="mt-3 text-[13px] text-bad">{error}</p> : null}
        <Button variant="primary" type="submit" className="mt-4 w-full" disabled={busy || !username || !password}>{busy ? "Please wait" : setup ? "Create administrator" : "Sign in"}</Button>
      </form>
    </div>
  );
}
