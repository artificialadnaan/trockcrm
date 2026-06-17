import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";

const {
  EXPECTED_PROCORE_COMPANY_ID,
  buildBackfillPlan,
  buildBackfillUpdateSql,
  normalizeProjectNumber,
  parseBackfillArgs,
  runBackfill,
  validateSingleCompanySafetyCheck,
} = await import("../../../scripts/backfill-procore-bid-board-ids.js");

function crmDeal(overrides: Partial<any> = {}) {
  return {
    tenantSchema: "office_dallas",
    dealId: "00000000-0000-4000-8000-000000000001",
    dealName: "Test Deal",
    bidBoardProjectNumber: " DFW-1-10026-aa ",
    projectNumberNorm: "dfw-1-10026-aa",
    procoreBidId: null,
    procoreCompanyId: null,
    ...overrides,
  };
}

function rfpRow(overrides: Partial<any> = {}) {
  return {
    rfpApprovalRequestId: 10,
    projectNumber: "DFW-1-10026-AA",
    projectNumberNorm: "dfw-1-10026-aa",
    bidboardProjectId: "562949955804589",
    approvedAt: new Date("2026-05-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("Procore Bid Board ID backfill", () => {
  it("normalizes project numbers by trimming and lowercasing only", () => {
    expect(normalizeProjectNumber("  DFW-1-10026-AA  ")).toBe("dfw-1-10026-aa");
    expect(normalizeProjectNumber("")).toBeNull();
    expect(normalizeProjectNumber(null)).toBeNull();
  });

  it("fails closed when dry-run, dry-check, and commit modes conflict", () => {
    expect(parseBackfillArgs(["node", "script"])).toMatchObject({ mode: "dry-run" });
    expect(parseBackfillArgs(["node", "script", "--dry-run"])).toMatchObject({ mode: "dry-run" });
    expect(parseBackfillArgs(["node", "script", "--dry-check"])).toMatchObject({ mode: "dry-check" });
    expect(parseBackfillArgs(["node", "script", "--commit"])).toMatchObject({ mode: "commit" });
    expect(() => parseBackfillArgs(["node", "script", "--dry-run", "--commit"])).toThrow(
      "Choose exactly one"
    );
  });

  it("requires the SyncHub company safety check to observe only the expected single company", () => {
    expect(
      validateSingleCompanySafetyCheck({
        expectedCompanyId: EXPECTED_PROCORE_COMPANY_ID,
        configCompanyId: EXPECTED_PROCORE_COMPANY_ID,
        callbackCompanyIds: [EXPECTED_PROCORE_COMPANY_ID],
      })
    ).toEqual([EXPECTED_PROCORE_COMPANY_ID]);

    expect(() =>
      validateSingleCompanySafetyCheck({
        expectedCompanyId: EXPECTED_PROCORE_COMPANY_ID,
        configCompanyId: EXPECTED_PROCORE_COMPANY_ID,
        callbackCompanyIds: [EXPECTED_PROCORE_COMPANY_ID, "111111111111111"],
      })
    ).toThrow("Single-company safety check failed");
  });

  it("plans only unambiguous approved numeric SyncHub matches and skips conflicts", () => {
    const plan = buildBackfillPlan({
      crmDeals: [
        crmDeal(),
        crmDeal({
          dealId: "00000000-0000-4000-8000-000000000002",
          bidBoardProjectNumber: "DFW-1-AMBIG",
          projectNumberNorm: "dfw-1-ambig",
        }),
        crmDeal({
          dealId: "00000000-0000-4000-8000-000000000003",
          bidBoardProjectNumber: "DFW-1-NOMATCH",
          projectNumberNorm: "dfw-1-nomatch",
        }),
        crmDeal({
          dealId: "00000000-0000-4000-8000-000000000004",
          bidBoardProjectNumber: "DFW-1-CONFLICT",
          projectNumberNorm: "dfw-1-conflict",
          procoreBidId: "999",
        }),
      ],
      syncHubRows: [
        rfpRow(),
        rfpRow({ rfpApprovalRequestId: 20, projectNumber: "DFW-1-AMBIG", projectNumberNorm: "dfw-1-ambig", bidboardProjectId: "111" }),
        rfpRow({ rfpApprovalRequestId: 21, projectNumber: "DFW-1-AMBIG", projectNumberNorm: "dfw-1-ambig", bidboardProjectId: "222" }),
        rfpRow({ rfpApprovalRequestId: 30, projectNumber: "DFW-1-CONFLICT", projectNumberNorm: "dfw-1-conflict", bidboardProjectId: "333" }),
      ],
      procoreCompanyId: EXPECTED_PROCORE_COMPANY_ID,
    });

    expect(plan.willUpdate).toHaveLength(1);
    expect(plan.willUpdate[0]).toMatchObject({
      dealId: "00000000-0000-4000-8000-000000000001",
      newProcoreBidId: "562949955804589",
      newProcoreCompanyId: EXPECTED_PROCORE_COMPANY_ID,
    });
    expect(plan.counts).toMatchObject({
      candidateDeals: 4,
      willUpdate: 1,
      skippedAmbiguousSyncHubMatch: 1,
      skippedNoSyncHubMatch: 1,
      skippedExistingConflict: 1,
    });
    expect(plan.ambiguousSyncHubMatches[0]).toMatchObject({
      projectNumberNorm: "dfw-1-ambig",
      bidboardProjectIds: ["111", "222"],
    });
  });

  it("builds guarded SQL that only writes procore_bid_id and procore_company_id", () => {
    const sql = buildBackfillUpdateSql("office_dallas").toLowerCase();

    expect(sql).toContain("update office_dallas.deals");
    expect(sql).toContain("procore_bid_id = $1::bigint");
    expect(sql).toContain("procore_company_id = $2");
    expect(sql).toContain("coalesce(on_hold, false) = false");
    expect(sql).toContain("lower(trim(bid_board_project_number)) = $4");
    expect(sql).not.toContain("updated_at");
    expect(sql).not.toContain("bid_board_linked_at");
    expect(sql).not.toContain("stage_id");
  });

  it("commit mode performs a SELECT-only verification after COMMIT", async () => {
    const queries: string[] = [];
    const fakeClient = {
      async query(sql: string) {
        queries.push(sql);
        const normalized = sql.toLowerCase();
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
        if (normalized.includes("already_linkable")) {
          return {
            rows: [
              {
                non_hold_active: 1,
                already_linkable: 0,
                missing_either_id: 1,
                missing_either_with_project_number: 1,
                missing_either_without_project_number: 0,
              },
            ],
            rowCount: 1,
          };
        }
        if (normalized.includes("procore_bid_id::text as procore_bid_id")) {
          return {
            rows: normalized.includes("from office_dallas.deals")
              ? [
                  {
                    deal_id: "00000000-0000-4000-8000-000000000001",
                    deal_name: "Test Deal",
                    bid_board_project_number: "DFW-1-10026-aa",
                    project_number_norm: "dfw-1-10026-aa",
                    procore_bid_id: null,
                    procore_company_id: null,
                  },
                ]
              : [],
            rowCount: normalized.includes("from office_dallas.deals") ? 1 : 0,
          };
        }
        if (normalized.trimStart().startsWith("update office_dallas.deals")) return { rows: [{ id: "updated" }], rowCount: 1 };
        if (normalized.includes("select (procore_bid_id =")) return { rows: [{ ok: true }], rowCount: 1 };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const report = await runBackfill({
      crmClient: fakeClient as never,
      syncHubRows: [rfpRow()],
      companyId: EXPECTED_PROCORE_COMPANY_ID,
      mode: "commit",
    });

    const commitIndex = queries.indexOf("COMMIT");
    const verificationIndexes = queries
      .map((query, index) => ({ query: query.toLowerCase(), index }))
      .filter(({ query }) => query.includes("select (procore_bid_id ="))
      .map(({ index }) => index);

    expect(report.updatedRows).toBe(1);
    expect(report.verifiedRows).toBe(1);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(verificationIndexes.some((index) => index > commitIndex)).toBe(true);

    // Regression (#746): the backup snapshot must be written under the OS temp dir (cross-platform),
    // never a hardcoded "/private/tmp" — that exists on macOS but not on Linux CI/Railway, where
    // fs.writeFileSync threw ENOENT. Assert the real path the run produced, then clean it up.
    expect(report.backupPath).toBeTruthy();
    expect(report.backupPath?.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(report.backupPath as string)).toBe(true);
    fs.rmSync(report.backupPath as string, { force: true });
  });
});
