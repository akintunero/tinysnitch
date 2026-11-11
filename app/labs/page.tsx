"use client";

import { LabsTable } from "@/components/labs-table";
import { useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/status-dot";

export default function Labs() {
  const { labs, refreshLabs } = useApp();
  return (
    <>
      <PageHeader title="Networks">
        <Button onClick={() => void refreshLabs()} disabled={labs.loading}>{labs.loading ? "Refreshing" : "Refresh"}</Button>
      </PageHeader>
      <LabsTable />
    </>
  );
}
