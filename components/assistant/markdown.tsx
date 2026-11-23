"use client";

import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders Claude's reply. react-markdown never emits raw HTML, and unsafe link schemes are dropped, so model
 * output cannot inject markup. Code blocks are the charcoal terminal panels from the design system.
 */
const components: ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mb-1 mt-4 text-[15px] font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1 mt-4 text-[15px] font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-3 text-[14px] font-semibold">{children}</h4>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-line pl-3 text-soft">{children}</blockquote>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2 hover:decoration-ink">{children}</a>,
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-[13px]">{children}</table></div>,
  th: ({ children }) => <th className="border-b border-line px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-line px-2 py-1 align-top">{children}</td>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-sm bg-ink p-3 font-mono text-[12px] leading-relaxed text-surface-2 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">{children}</pre>,
  code: ({ children }) => <code className="rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-[12px]">{children}</code>,
};

export function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>;
}
