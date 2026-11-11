"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import type { ChatEvent } from "@/lib/assistant/chat";
import type { Conversation, Part, StoredMessage } from "@/lib/assistant/history";
import { apiGet, apiSend } from "@/lib/client";
import { Markdown } from "./markdown";
import { ToolCall } from "./tool-call";

type UiMessage = { key: string; role: "user" | "assistant"; parts: Part[]; error: string | null; streaming: boolean };

const EXAMPLES = [
  "What devices are in this lab?",
  "Show me the current network topology.",
  "Which interfaces are administratively down?",
  "Show the running configuration of the first router.",
  "Why might OSPF adjacency not be forming?",
  "Give me a health summary of this lab.",
];

const fromStored = (m: StoredMessage): UiMessage => ({ key: `s${m.id}`, role: m.role, parts: m.parts, error: m.error, streaming: false });

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
    if (!id) { setConversationId(null); setMessages([]); return; }
    try {
      const r = await apiGet<{ messages: StoredMessage[] }>(`/api/conversations/${id}`);
      setConversationId(id);
      setMessages(r.messages.map(fromStored));
      pinned.current = true;
    } catch (e) { setProblem((e as Error).message); }
  };

  const remove = async () => {
    if (!conversationId) return;
    try { await apiSend("DELETE", `/api/conversations/${conversationId}`); } catch (e) { setProblem((e as Error).message); }
    await open(null);
    await loadList();
  };

  const patchLast = (fn: (m: UiMessage) => UiMessage) => setMessages((all) => all.map((m, i) => (i === all.length - 1 ? fn(m) : m)));

  const apply = (e: ChatEvent) => {
    if (e.type === "conversation") { setConversationId(e.id); return; }
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
        <h1 className="text-[17px] font-semibold tracking-tight">Network Assistant</h1>
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
        </div>
      </div>

      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto pr-1" aria-live="polite">
        {messages.length === 0 ? (
          <div className="py-6">
            <p className="text-[13px]">Ask about the selected network. The assistant reads real device and topology data each time it answers. It cannot change a device itself: when you ask for a change it files a proposal, which you approve on the Configurations page.</p>
            <ul className="mt-4 space-y-1.5">
              {EXAMPLES.map((q) => <li key={q}><button type="button" onClick={() => { setInput(q); inputRef.current?.focus(); }} className="text-left text-[13px] underline decoration-line underline-offset-2 hover:decoration-ink">{q}</button></li>)}
            </ul>
          </div>
        ) : null}
        {messages.map((m) => (
          <div key={m.key} className="border-b border-line py-3 last:border-0">
            <div className="text-soft mb-1 text-[11px] font-semibold uppercase tracking-wide">{m.role === "user" ? "You" : "Tiny Snitch"}</div>
            {m.parts.map((p, i) => p.type === "text"
              ? (m.role === "user" ? <p key={i} className="whitespace-pre-wrap break-words text-[14px]">{p.text}</p> : <div key={i} className="break-words text-[14px]"><Markdown>{p.text}</Markdown></div>)
              : <ToolCall key={p.id} part={p} />)}
            {m.streaming ? <p className="text-soft mt-1 text-[12px]">{running ? "Reading from CML..." : m.parts.length ? "Writing..." : "Working..."}</p> : null}
            {m.error ? <p role="alert" className="mt-1 text-[13px] text-bad">{m.error}</p> : null}
          </div>
        ))}
      </div>

      {problem ? <p role="alert" className="mt-2 text-[13px] text-bad">{problem}</p> : null}
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
