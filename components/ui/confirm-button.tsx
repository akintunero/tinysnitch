"use client";

import { useState } from "react";
import { Button } from "./button";

/**
 * A destructive action in two steps. The first click only asks; the message says what will be lost, and nothing is
 * deleted until it is confirmed. Anything that failed is shown beside the button, not swallowed.
 */
export function ConfirmButton({ label, confirmLabel = "Yes, delete", message, onConfirm, disabled, size = "md", variant = "secondary", onDone }: {
  label: string;
  confirmLabel?: string;
  message: string;
  onConfirm: () => Promise<unknown>;
  disabled?: boolean;
  size?: "sm" | "md";
  variant?: "primary" | "secondary" | "ghost";
  onDone?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setAsking(false);
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!asking) return <Button size={size} variant={variant} disabled={disabled} onClick={() => { setError(null); setAsking(true); }}>{label}</Button>;
  return (
    <span role="alertdialog" aria-label={label} className="inline-flex flex-wrap items-center gap-2 rounded-sm border border-bad/60 bg-surface px-2 py-1.5">
      <span className="max-w-xs text-[12px]">{message}</span>
      <Button size="sm" variant="primary" className="border-bad bg-bad text-white" disabled={busy} onClick={() => void run()}>{busy ? "Working" : confirmLabel}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>Cancel</Button>
      {error ? <span role="alert" className="w-full text-[12px] text-bad">{error}</span> : null}
    </span>
  );
}
