import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui/status-dot";

/** Honest placeholder for a workspace that a later phase builds. It shows no data and implies none. */
export function ComingLater({ title, phase, children }: { title: string; phase: number; children: React.ReactNode }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title={`Built in Phase ${phase}`} action={<Link href="/labs" className="text-[13px] underline">Choose a lab</Link>}>
        {children}
      </EmptyState>
    </>
  );
}
