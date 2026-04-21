export interface AdminDashboardSummary {
  aiActions: { pendingCount: number; oldestAgeLabel: string };
  interventions: { openCount: number; oldestAgeLabel: string };
  disconnects: { totalCount: number; primaryClusterLabel: string };
  mergeQueue: { openCount: number; oldestAgeLabel: string };
  migration: { unresolvedCount: number; oldestAgeLabel: string };
  audit: { changeCount24h: number; lastActorLabel: string };
  procore: { conflictCount: number; healthLabel: string };
}

export interface AdminOperationsTile {
  key: string;
  title: string;
  valueLabel: string;
  secondaryLabel: string;
  href: string;
}

export function buildAdminOperationsTiles(summary: AdminDashboardSummary): AdminOperationsTile[] {
  return [
    {
      key: "ai-actions",
      title: "AI Actions",
      valueLabel: String(summary.aiActions.pendingCount),
      secondaryLabel: `Oldest ${summary.aiActions.oldestAgeLabel}`,
      href: "/admin/ai-actions",
    },
    {
      key: "interventions",
      title: "Interventions",
      valueLabel: String(summary.interventions.openCount),
      secondaryLabel: `Oldest ${summary.interventions.oldestAgeLabel}`,
      href: "/admin/interventions",
    },
    {
      key: "disconnects",
      title: "Process Disconnects",
      valueLabel: String(summary.disconnects.totalCount),
      secondaryLabel: summary.disconnects.primaryClusterLabel,
      href: "/admin/sales-process-disconnects",
    },
    {
      key: "merge-queue",
      title: "Merge Queue",
      valueLabel: String(summary.mergeQueue.openCount),
      secondaryLabel: `Oldest ${summary.mergeQueue.oldestAgeLabel}`,
      href: "/admin/merge-queue",
    },
    {
      key: "migration",
      title: "Migration",
      valueLabel: String(summary.migration.unresolvedCount),
      secondaryLabel: `Oldest ${summary.migration.oldestAgeLabel}`,
      href: "/admin/migration",
    },
    {
      key: "audit",
      title: "Audit Log",
      valueLabel: String(summary.audit.changeCount24h),
      secondaryLabel: summary.audit.lastActorLabel,
      href: "/admin/audit",
    },
    {
      key: "procore",
      title: "Procore Sync",
      valueLabel: String(summary.procore.conflictCount),
      secondaryLabel: summary.procore.healthLabel,
      href: "/admin/procore",
    },
  ];
}
