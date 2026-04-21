export interface AdminDashboardKpi {
  label: string;
  value: string;
  detail: string;
}

export interface AdminWorkspaceItem {
  key: string;
  label: string;
  value: string;
  detail: string;
  href: string;
}

export interface AdminRecentActivityItem {
  key: string;
  label: string;
  detail: string;
}

export function buildAdminDashboardSummary(input: {
  aiActionCount: number;
  openInterventionCount: number;
  mergeQueueCount: number;
  disconnectCount: number;
  migrationExceptionCount: number;
  procoreIssueCount: number;
  unhealthySources: string[];
  auditChangeCount24h: number;
  pipelineValue: number;
  activeDealCount: number;
}) {
  const needsAttention =
    input.aiActionCount +
    input.openInterventionCount +
    input.mergeQueueCount +
    input.migrationExceptionCount;

  return {
    kpis: [
      {
        label: "Needs attention",
        value: String(needsAttention),
        detail: `${input.aiActionCount} AI actions • ${input.openInterventionCount} intervention cases`,
      },
      {
        label: "System health",
        value: String(input.unhealthySources.length),
        detail:
          input.unhealthySources.length === 0
            ? "All monitored sources healthy"
            : input.unhealthySources.join(" • "),
      },
      {
        label: "Workspace changes",
        value: String(input.auditChangeCount24h),
        detail: "Audit events in the last 24 hours",
      },
      {
        label: "Team snapshot",
        value: `$${input.pipelineValue.toLocaleString()}`,
        detail: `${input.activeDealCount} active deals`,
      },
    ] satisfies AdminDashboardKpi[],
    workspaceItems: [
      {
        key: "ai-actions",
        label: "AI Actions",
        value: String(input.aiActionCount),
        detail: "Open AI queue items",
        href: "/admin/ai-actions",
      },
      {
        key: "interventions",
        label: "Interventions",
        value: String(input.openInterventionCount),
        detail: "Open intervention cases",
        href: "/admin/interventions",
      },
      {
        key: "merge-queue",
        label: "Merge Queue",
        value: String(input.mergeQueueCount),
        detail: "Pending duplicate merges",
        href: "/admin/merge-queue",
      },
      {
        key: "migration",
        label: "Migration",
        value: String(input.migrationExceptionCount),
        detail: "Unresolved migration exceptions",
        href: "/admin/migration",
      },
      {
        key: "process-disconnects",
        label: "Process Disconnects",
        value: String(input.disconnectCount),
        detail: "Current sales process disconnect rows",
        href: "/admin/sales-process-disconnects",
      },
      {
        key: "audit-log",
        label: "Audit Log",
        value: String(input.auditChangeCount24h),
        detail: "Recent admin-facing audit events",
        href: "/admin/audit",
      },
      {
        key: "procore-sync",
        label: "Procore Sync",
        value: String(input.procoreIssueCount),
        detail: "Current Procore sync issues",
        href: "/admin/procore",
      },
    ] satisfies AdminWorkspaceItem[],
    recentActivity: [
      {
        key: "audit-window",
        label: "Audit window",
        detail: `${input.auditChangeCount24h} admin-facing changes in the last 24 hours`,
      },
      {
        key: "system-health",
        label: "System health detail",
        detail:
          input.unhealthySources.length === 0
            ? "All monitored sources healthy"
            : `Watch ${input.unhealthySources.join(" • ")}`,
      },
    ] satisfies AdminRecentActivityItem[],
  };
}
