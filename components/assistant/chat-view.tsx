"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import type { ChatEvent } from "@/lib/assistant/chat";
import type { Conversation, Part, StoredMessage } from "@/lib/assistant/history";
import { apiGet, apiSend } from "@/lib/client";
import { Markdown } from "./markdown";
import { ToolCall } from "./tool-call";

type UiMessage = { key: string; role: "user" | "assistant"; parts: Part[]; error: string | null; streaming: boolean };

/** Starting questions that name the selected network and one of its routers, so they fit what is on screen. */
const examples = (network: string | null, router: string | null) => [
  `Summarise the health of ${network ?? "this network"}.`,
  "Which interfaces are down, and is that expected?",
  router ? `Show the running configuration of ${router}.` : "Show the running configuration of a router.",
  "Which routing sessions are not established, and why?",
  "What changed on these devices recently?",
];

const KEY = "ts.conversation";
const remember = (id: string | null) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* storage can be blocked */ } };
const recall = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

const fromStored =(m: StoredMessage): UiMessage => ({ key: `s${m.id}`, role: m.role, parts: m.parts, error: m.error, streaming: false });

/** Whether what is sent to the AI model is masked for a network. Mirrors the server: an unknown environment counts as production. */
export const isMasked = (mode: string, environment: string | null) => mode === "all" || (mode === "production" && environment !== "lab");

/** Says, where the question is typed, what leaves this server and what does not. */
function PrivacyNotice({ mode, environment }: { mode: string; environment: string | null }) {
  const masked = isMasked(mode, environment);
  return (
    <p className={`mt-3 border-l-2 pl-2.5 text-[12px] ${masked ? "border-line text-soft" : "border-warn text-warn"}`} data-testid="privacy-notice">
      {masked ? (
        <><strong className="font-semibold text-ink">Your network data is pseudonymised before it reaches the AI model.</strong> Addresses, device and network names, MAC addresses, public AS numbers, descriptions and banners are swapped for stand-ins, and passwords and keys are removed. The real values are put back here; the mapping never leaves this server. Names no one declared can slip through, so add customer and site names under{" "}</>
      ) : (
        <><strong className="font-semibold">Not masked for this network: the AI model sees real addresses and names.</strong> Passwords and keys are still removed. To hide the rest, change it under{" "}</>
      )}
      <a href="/settings#privacy" className="underline underline-offset-2">Settings, Privacy</a>.
    </p>
  );
}

export function ChatView() {
  const { settings, labs } = useApp();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
  const [router, setRouter] = useState<string | null>(null);
  useEffect(() => {
    setRouter(null);
    const id = settings?.selectedLabId;
    if (!id) return;
    apiGet<{ nodes: { label: string; kind: string }[] }>(`/api/labs/${encodeURIComponent(id)}/topology`)
      .then((t) => setRouter(t.nodes.find((n) => n.kind === "router" || n.kind === "l3switch")?.label ?? null))
      .catch(() => undefined);
  }, [settings?.selectedLabId]);
  const labTitle = labs.labs.find((l) => l.id === settings?.selectedLabId)?.title ?? settings?.selectedLabTitle ?? null;

  const loadList = useCallback(async () => {
    try { setConversations((await apiGet<{ conversations: Conversation[] }>("/api/conversations")).conversations); } catch { /* the list is a convenience */ }
  }, []);
  useEffect(() => { void loadList(); }, [loadList, settings?.selectedLabId]);

  // A question handed over from another page (a finding's "Ask the assistant") arrives as ?q=, and is only prefilled:
  // the engineer reads it and presses Send.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) { setInput(q.slice(0, 4000)); inputRef.current?.focus(); }
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages]);

  const open = async (id: string | null) => {
    setProblem(null);
    setConfirmDelete(false);
    if (!id) { setConversationId(null); setMessages([]); remember(null); return; }
    try {
      const r = await apiGet<{ messages: StoredMessage[] }>(`/api/conversations/${id}`);
      setConversationId(id);
      remember(id);
      const shown = r.messages.map(fromStored);
      // The server keeps answering after you leave the page and saves the reply when it is done. If the last saved
      // message is still the question, show it as pending and look again until the answer arrives.
      if (shown.at(-1)?.role === "user") shown.push({ key: "pending", role: "assistant", parts: [], error: null, streaming: true });
      setMessages(shown);
      pinned.current = true;
      if (shown.at(-1)?.key === "pending") waitFor(id);
    } catch (e) { setProblem((e as Error).message); remember(null); }
  };

  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (poll.current) clearTimeout(poll.current); }, []);
  const waitFor = (id: string, tries = 0) => {
    if (poll.current) clearTimeout(poll.current);
    poll.current = setTimeout(async () => {
      try {
        const r = await apiGet<{ messages: StoredMessage[] }>(`/api/conversations/${id}`);
        if (r.messages.at(-1)?.role === "assistant") { setMessages(r.messages.map(fromStored)); return; }
      } catch { /* try again */ }
      if (tries < 100) waitFor(id, tries + 1);
      else patchLast((m) => ({ ...m, streaming: false, error: "No answer was saved. Ask again." }));
    }, 3000);
  };

  // Leaving the page unmounts this view, so the open conversation is remembered and reopened on return.
  // A question handed over with ?q= starts fresh instead.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("q")) return;
    const id = recall();
    if (id) void open(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async () => {
    if (!conversationId) return;
    try { await apiSend("DELETE", `/api/conversations/${conversationId}`); } catch (e) { setProblem((e as Error).message); }
    await open(null);
    await loadList();
  };

  const patchLast = (fn: (m: UiMessage) => UiMessage) => setMessages((all) => all.map((m, i) => (i === all.length - 1 ? fn(m) : m)));

  const apply = (e: ChatEvent) => {
    if (e.type === "conversation") { setConversationId(e.id); remember(e.id); return; }
    patchLast((m) => {
      const parts = [...m.parts];
      if (e.type === "text") {
        const tail = parts.at(-1);
        if (tail?.type === "text") parts[parts.length - 1] = { ...tail, text: tail.text + e.delta };
        else parts.push({ type: "text", text: e.delta });
        return { ...m, parts };
      }
      if (e.type === "tool_start") return { ...m, parts: [...parts, { type: "tool", id: e.id, tool: e.tool, input: e.input, ok: null, output: "", ms: null }] };
      if (e.type === "tool_result") return { ...m, parts: parts.map((p) => (p.type === "tool" && p.id === e.id ? { ...p, ok: e.ok, output: e.output, ms: e.ms } : p)) };
      if (e.type === "error") return { ...m, error: e.message, streaming: false };
      return { ...m, streaming: false }; // done
    });
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    setInput("");
    setProblem(null);
    setBusy(true);
    pinned.current = true;
    setMessages((all) => [
      ...all,
      { key: `u${Date.now()}`, role: "user", parts: [{ type: "text", text }], error: null, streaming: false },
      { key: `a${Date.now()}`, role: "assistant", parts: [], error: null, streaming: true },
    ]);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, conversationId: conversationId ?? undefined }), signal: ac.signal });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        patchLast((m) => ({ ...m, error: body?.error ?? `The request failed (${res.status}).`, streaming: false }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) apply(JSON.parse(line) as ChatEvent);
        }
      }
    } catch (e) {
      patchLast((m) => ({ ...m, error: ac.signal.aborted ? "Stopped." : (e as Error).message, streaming: false }));
    } finally {
      patchLast((m) => ({ ...m, streaming: false }));
      abort.current = null;
      setBusy(false);
      void loadList();
    }
  };

  const running = messages.at(-1)?.parts.some((p) => p.type === "tool" && p.ok === null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-3">
        <h1 className="text-[20px] font-semibold leading-7 tracking-tight">Network Assistant</h1>
        <span className="text-soft text-[12px]">{labTitle ? `Network: ${labTitle}` : "No network selected"}</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-2 text-[12px]">
            <span className="sr-only">Conversation</span>
            <select value={conversationId ?? ""} onChange={(e) => void open(e.target.value || null)} disabled={busy} className="h-7 max-w-[14rem] rounded-sm border border-line bg-bg px-2 text-[12px]">
              <option value="">New conversation</option>
              {conversations.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </label>
          {conversationId ? (confirmDelete
            ? <><Button size="sm" onClick={() => void remove()}>Delete it</Button><Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button></>
            : <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</Button>) : null}
          {conversations.length > 1 && !busy ? (
            <ConfirmButton
              size="sm"
              variant="ghost"
              label="Delete all"
              message={`Deletes all ${conversations.length} conversations for this network, messages included. Recorded in Activity.`}
              onConfirm={() => apiSend("DELETE", "/api/conversations")}
              onDone={async () => { await open(null); await loadList(); }}
            />
          ) : null}
        </div>
      </div>

      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto pr-1" aria-live="polite">
        {messages.length === 0 ? (
          <div className="py-6">
            <p className="text-[13px]">Ask about the selected network. The assistant reads live device data each time it answers. It cannot change a device: a change you ask for becomes a proposal on the Configurations page.</p>
            <ul className="mt-4 space-y-1.5">
              {examples(labTitle, router).map((q) => <li key={q}><button type="button" onClick={() => { setInput(q); inputRef.current?.focus(); }} className="text-left text-[13px] underline decoration-line underline-offset-2 hover:decoration-ink">{q}</button></li>)}
            </ul>
          </div>
        ) : null}
        {messages.map((m) => (
          <div key={m.key} className="border-b border-line py-3 last:border-0">
            <div className="text-soft mb-1 text-[11px] font-semibold uppercase tracking-wide">{m.role === "user" ? "You" : "Tiny Snitch"}</div>
            {m.parts.map((p, i) => p.type === "text"
              ? (m.role === "user" ? <p key={i} className="whitespace-pre-wrap break-words text-[14px]">{p.text}</p> : <div key={i} className="break-words text-[14px]"><Markdown>{p.text}</Markdown></div>)
              : <ToolCall key={p.id} part={p} />)}
            {m.streaming ? <p className="text-soft mt-1 text-[12px]">{running ? "Reading from the network..." : m.parts.length ? "Writing..." : "Working..."}</p> : null}
            {m.error ? <p role="alert" className="mt-1 text-[13px] text-bad">{m.error}</p> : null}
          </div>
        ))}
      </div>

      {problem ? <p role="alert" className="mt-2 text-[13px] text-bad">{problem}</p> : null}
      {settings ? <PrivacyNotice mode={settings.llmPrivacy} environment={labs.labs.find((l) => l.id === settings.selectedLabId)?.environment ?? null} /> : null}
      <form className="mt-3 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="assistant-input">Message</label>
        <textarea id="assistant-input" ref={inputRef} rows={2} value={input} maxLength={4000} onChange={(e) => setInput(e.target.value)} placeholder="Ask about the network, a device, or a problem"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          className="min-h-[3rem] flex-1 resize-y rounded-sm border border-line bg-surface px-2.5 py-2 text-[14px] placeholder:text-muted" />
        {busy ? <Button onClick={() => abort.current?.abort()}>Stop</Button> : <Button variant="primary" type="submit" disabled={!input.trim()}>Send</Button>}
      </form>
    </div>
  );
}
