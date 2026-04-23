import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface AdminDataScrubOverview {
  summary: {
    openDuplicateContacts: number;
    resolvedDuplicateContacts7d: number;
    openOwnershipGaps: number;
    recentScrubActions7d: number;
  };
  backlogBuckets: Array<{
    bucketKey: "duplicate_contacts" | "ownership_gaps";
    label: string;
    count: number;
    linkPath: string;
  }>;
  ownershipCoverage: Array<{
    gapKey:
      | "deals_missing_region"
      | "contacts_missing_company"
      | "deals_primary_contact_company_mismatch";
    label: string;
    count: number;
  }>;
  scrubActivityByUser: Array<{
    userId: string | null;
    userName: string;
    actionCount: number;
    ownershipEditCount: number;
    lastActionAt: string | null;
  }>;
}

const OWNERSHIP_GAP_LABELS: Record<
  AdminDataScrubOverview["ownershipCoverage"][number]["gapKey"],
  string
> = {
  deals_missing_region: "Deals Missing Region",
  contacts_missing_company: "Contacts Missing Company",
  deals_primary_contact_company_mismatch: "Deal / Primary Contact Company Mismatch",
};

export async function getAdminDataScrubOverview(
  tenantDb: TenantDb
): Promise<AdminDataScrubOverview> {
  const duplicateResult = await tenantDb.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE dq.status = 'pending')::int AS open_duplicate_contacts,
      COUNT(*) FILTER (WHERE dq.resolved_at >= (NOW() - INTERVAL '7 days'))::int AS resolved_duplicate_contacts_7d
    FROM duplicate_queue dq
  `);

  const ownershipResult = await tenantDb.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM deals d WHERE d.region_id IS NULL) AS deals_missing_region,
      (SELECT COUNT(*)::int FROM contacts c WHERE c.company_id IS NULL) AS contacts_missing_company,
      (
        SELECT COUNT(*)::int
        FROM deals d
        LEFT JOIN contacts c ON c.id = d.primary_contact_id
        WHERE d.primary_contact_id IS NOT NULL
          AND d.company_id IS NOT NULL
          AND c.company_id IS NOT NULL
          AND c.company_id IS DISTINCT FROM d.company_id
      ) AS deals_primary_contact_company_mismatch
  `);

  const recentActionsResult = await tenantDb.execute(sql`
    SELECT
      COUNT(*)::int AS recent_scrub_actions_7d
    FROM audit_log al
    WHERE al.created_at >= (NOW() - INTERVAL '7 days')
      AND al.table_name IN ('deals', 'contacts')
      AND EXISTS (
        SELECT 1
        FROM jsonb_object_keys(COALESCE(al.changes, '{}'::jsonb)) AS key(field_name)
        WHERE field_name IN ('assigned_rep_id', 'region_id', 'company_id', 'primary_contact_id', 'source_lead_id', 'property_id')
      )
  `);

  const scrubActivityResult = await tenantDb.execute(sql`
    SELECT
      al.changed_by AS user_id,
      COALESCE(u.display_name, 'System') AS user_name,
      COUNT(*)::int AS action_count,
      COUNT(*) FILTER (
        WHERE al.table_name IN ('deals', 'contacts')
          AND EXISTS (
            SELECT 1
            FROM jsonb_object_keys(COALESCE(al.changes, '{}'::jsonb)) AS key(field_name)
            WHERE field_name IN ('assigned_rep_id', 'region_id', 'company_id', 'primary_contact_id', 'source_lead_id', 'property_id')
          )
      )::int AS ownership_edit_count,
      MAX(al.created_at) AS last_action_at
    FROM audit_log al
    LEFT JOIN public.users u ON u.id = al.changed_by
    WHERE al.created_at >= (NOW() - INTERVAL '30 days')
      AND al.table_name IN ('deals', 'contacts')
      AND EXISTS (
        SELECT 1
        FROM jsonb_object_keys(COALESCE(al.changes, '{}'::jsonb)) AS key(field_name)
        WHERE field_name IN ('assigned_rep_id', 'region_id', 'company_id', 'primary_contact_id', 'source_lead_id', 'property_id')
      )
    GROUP BY al.changed_by, u.display_name
    ORDER BY action_count DESC, last_action_at DESC
  `);

  const duplicateResolutionActivityResult = await tenantDb.execute(sql`
    SELECT
      dq.resolved_by AS user_id,
      COALESCE(u.display_name, 'System') AS user_name,
      COUNT(*)::int AS duplicate_resolution_count,
      MAX(dq.resolved_at) AS last_resolution_at
    FROM duplicate_queue dq
    LEFT JOIN public.users u ON u.id = dq.resolved_by
    WHERE dq.resolved_at >= (NOW() - INTERVAL '30 days')
      AND dq.status IN ('merged', 'dismissed')
    GROUP BY dq.resolved_by, u.display_name
  `);

  const duplicateRows = (duplicateResult as any).rows ?? duplicateResult;
  const ownershipRows = (ownershipResult as any).rows ?? ownershipResult;
  const recentActionRows = (recentActionsResult as any).rows ?? recentActionsResult;
  const scrubActivityRows = (scrubActivityResult as any).rows ?? scrubActivityResult;
  const duplicateResolutionRows =
    (duplicateResolutionActivityResult as any).rows ?? duplicateResolutionActivityResult;

  const duplicateRow = duplicateRows[0] ?? {};
  const ownershipRow = ownershipRows[0] ?? {};
  const recentActionRow = recentActionRows[0] ?? {};

  const ownershipCoverage: AdminDataScrubOverview["ownershipCoverage"] = [
    {
      gapKey: "deals_missing_region",
      label: OWNERSHIP_GAP_LABELS.deals_missing_region,
      count: Number(ownershipRow.deals_missing_region ?? 0),
    },
    {
      gapKey: "contacts_missing_company",
      label: OWNERSHIP_GAP_LABELS.contacts_missing_company,
      count: Number(ownershipRow.contacts_missing_company ?? 0),
    },
    {
      gapKey: "deals_primary_contact_company_mismatch",
      label: OWNERSHIP_GAP_LABELS.deals_primary_contact_company_mismatch,
      count: Number(ownershipRow.deals_primary_contact_company_mismatch ?? 0),
    },
  ];

  const openDuplicateContacts = Number(duplicateRow.open_duplicate_contacts ?? 0);
  const resolvedDuplicateContacts7d = Number(duplicateRow.resolved_duplicate_contacts_7d ?? 0);
  const openOwnershipGaps = ownershipCoverage.reduce((sum, row) => sum + row.count, 0);
  const recentScrubActions7d =
    Number(recentActionRow.recent_scrub_actions_7d ?? 0) + resolvedDuplicateContacts7d;

  const scrubActivityMap = new Map<
    string,
    AdminDataScrubOverview["scrubActivityByUser"][number]
  >();

  for (const row of scrubActivityRows) {
    const userId = row.user_id ?? null;
    const key = userId ?? "system";
    scrubActivityMap.set(key, {
      userId,
      userName: row.user_name ?? "System",
      actionCount: Number(row.action_count ?? 0),
      ownershipEditCount: Number(row.ownership_edit_count ?? 0),
      lastActionAt: row.last_action_at ?? null,
    });
  }

  for (const row of duplicateResolutionRows) {
    const userId = row.user_id ?? null;
    const key = userId ?? "system";
    const duplicateResolutionCount = Number(row.duplicate_resolution_count ?? 0);
    const lastResolutionAt = row.last_resolution_at ?? null;
    const existing = scrubActivityMap.get(key);

    if (existing) {
      scrubActivityMap.set(key, {
        ...existing,
        actionCount: existing.actionCount + duplicateResolutionCount,
        lastActionAt:
          existing.lastActionAt && lastResolutionAt
            ? existing.lastActionAt >= lastResolutionAt
              ? existing.lastActionAt
              : lastResolutionAt
            : existing.lastActionAt ?? lastResolutionAt,
      });
    } else {
      scrubActivityMap.set(key, {
        userId,
        userName: row.user_name ?? "System",
        actionCount: duplicateResolutionCount,
        ownershipEditCount: 0,
        lastActionAt: lastResolutionAt,
      });
    }
  }

  const scrubActivityByUser = Array.from(scrubActivityMap.values()).sort((a, b) => {
    if (b.actionCount !== a.actionCount) return b.actionCount - a.actionCount;
    if (a.lastActionAt === b.lastActionAt) return 0;
    if (!a.lastActionAt) return 1;
    if (!b.lastActionAt) return -1;
    return b.lastActionAt.localeCompare(a.lastActionAt);
  });

  return {
    summary: {
      openDuplicateContacts,
      resolvedDuplicateContacts7d,
      openOwnershipGaps,
      recentScrubActions7d,
    },
    backlogBuckets: [
      {
        bucketKey: "duplicate_contacts",
        label: "Duplicate Contacts",
        count: openDuplicateContacts,
        linkPath: "/admin/merge-queue",
      },
      {
        bucketKey: "ownership_gaps",
        label: "Ownership Gaps",
        count: openOwnershipGaps,
        linkPath: "/admin/audit",
      },
    ],
    ownershipCoverage,
    scrubActivityByUser,
  };
}
