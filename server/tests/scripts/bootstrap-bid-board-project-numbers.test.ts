import { describe, expect, it } from "vitest";

const {
  buildBootstrapAuditInsertSql,
  buildBootstrapReport,
  buildBootstrapUpdateSql,
  classifySyncMappingCandidates,
} = await import("../../../scripts/bootstrap-bid-board-project-numbers.js");

function candidate(
  syncMappingId: number,
  hubspotDealId: string,
  projectNumber: string,
  createdAt: string
) {
  return {
    syncMappingId,
    hubspotDealId,
    projectNumber,
    bidboardProjectId: `bb-${syncMappingId}`,
    createdAt: new Date(createdAt),
  };
}

describe("Bid Board project-number bootstrap", () => {
  it("keeps the newest temporal duplicate and skips ambiguous mappings", () => {
    const classified = classifySyncMappingCandidates([
      candidate(1, "hs-temporal", "DFW-4-100-aa", "2026-04-01T00:00:00Z"),
      candidate(2, "hs-temporal", "DFW-4-100-aa", "2026-04-02T00:00:00Z"),
      candidate(3, "hs-ambiguous", "DFW-4-101-aa", "2026-04-01T00:00:00Z"),
      candidate(4, "hs-ambiguous", "DFW-4-102-aa", "2026-04-02T00:00:00Z"),
      candidate(5, "hs-a", "DFW-4-103-aa", "2026-04-01T00:00:00Z"),
      candidate(6, "hs-b", "DFW-4-103-aa", "2026-04-02T00:00:00Z"),
    ]);

    expect(classified.canonical.map((row) => row.syncMappingId)).toEqual([2]);
    expect(classified.supersededTemporalRows).toHaveLength(1);
    expect(classified.supersededTemporalRows[0]?.row.syncMappingId).toBe(1);
    expect(classified.ambiguousHubspotRows.map((row) => row.syncMappingId)).toEqual([3, 4]);
    expect(classified.ambiguousProjectRows.map((row) => row.syncMappingId)).toEqual([5, 6]);
  });

  it("builds a dry-run report whose categories sum to candidate count", () => {
    const candidates = [
      candidate(1, "hs-temporal", "DFW-4-100-aa", "2026-04-01T00:00:00Z"),
      candidate(2, "hs-temporal", "DFW-4-100-aa", "2026-04-02T00:00:00Z"),
      candidate(3, "hs-ambiguous", "DFW-4-101-aa", "2026-04-01T00:00:00Z"),
      candidate(4, "hs-ambiguous", "DFW-4-102-aa", "2026-04-02T00:00:00Z"),
      candidate(5, "hs-a", "DFW-4-103-aa", "2026-04-01T00:00:00Z"),
      candidate(6, "hs-b", "DFW-4-103-aa", "2026-04-02T00:00:00Z"),
      candidate(7, "hs-orphan", "DFW-4-104-aa", "2026-04-03T00:00:00Z"),
      candidate(8, "hs-populated", "DFW-4-105-aa", "2026-04-03T00:00:00Z"),
      candidate(9, "hs-update", "DFW-4-106-aa", "2026-04-03T00:00:00Z"),
    ];
    const classified = classifySyncMappingCandidates(candidates);
    const matches = new Map([
      [
        "hs-temporal",
        [
          {
            tenantSchema: "office_atlanta",
            dealId: "deal-temporal",
            hubspotDealId: "hs-temporal",
            bidBoardProjectNumber: null,
          },
        ],
      ],
      [
        "hs-populated",
        [
          {
            tenantSchema: "office_dallas",
            dealId: "deal-populated",
            hubspotDealId: "hs-populated",
            bidBoardProjectNumber: "DFW-OLD",
          },
        ],
      ],
      [
        "hs-update",
        [
          {
            tenantSchema: "office_dallas",
            dealId: "deal-update",
            hubspotDealId: "hs-update",
            bidBoardProjectNumber: null,
          },
        ],
      ],
    ]);

    const report = buildBootstrapReport({
      runId: "00000000-0000-4000-8000-000000000000",
      dryRun: true,
      candidateCount: candidates.length,
      classified,
      crmMatchesByHubspotDealId: matches,
    });

    expect(report.willUpdateCount).toBe(2);
    expect(report.skippedAmbiguousHubspotDealIdCount).toBe(2);
    expect(report.skippedAmbiguousProjectNumberCount).toBe(2);
    expect(report.skippedAlreadyPopulatedCount).toBe(1);
    expect(report.skippedNoCrmDealCount).toBe(1);
    expect(report.supersededTemporalDuplicateCount).toBe(1);
    expect(report.sanityTotal).toBe(candidates.length);
    expect(report.tenantWillUpdate.office_atlanta).toBe(1);
    expect(report.tenantWillUpdate.office_dallas).toBe(1);
  });

  it("builds guarded SQL for idempotent non-money-field updates and audit inserts", () => {
    const updateSql = buildBootstrapUpdateSql("office_dallas").toLowerCase();
    const auditSql = buildBootstrapAuditInsertSql("office_dallas").toLowerCase();

    expect(updateSql).toContain("update office_dallas.deals");
    expect(updateSql).toContain("bid_board_project_number = $1");
    expect(updateSql).toContain("bid_board_project_number is null");
    expect(updateSql).toContain("hubspot_deal_id = $3");
    expect(updateSql).not.toContain("awarded_amount");
    expect(updateSql).not.toContain("bid_board_project_cost");
    expect(updateSql).not.toContain("bid_board_total_sales");
    expect(updateSql).not.toContain("stage_id");

    expect(auditSql).toContain("insert into office_dallas.bid_board_bootstrap_log");
    expect(auditSql).toContain("source_sync_mapping_id");
    expect(auditSql).toContain("tenant_schema");
    expect(auditSql).toContain("hubspot_deal_id");
    expect(auditSql).toContain("bid_board_project_number");
  });
});
