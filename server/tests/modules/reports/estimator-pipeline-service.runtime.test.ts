import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getEstimatorPipelineEvidence,
  getEstimatorPipelineReport,
} from "../../../src/modules/reports/estimator-pipeline-service.js";

/**
 * REAL-SQL coverage for the estimator pipeline report. The fixture deliberately mixes canonical,
 * historical, and service-route stages so the summary and evidence paths must make the same cohort and
 * canonicalization decisions. Absolute anchors keep a shared mistake from passing via reconciliation alone.
 */
const U = (suffix: string) => `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`;
const REPORT_NOW = new Date("2026-07-13T12:00:00.000Z");

const SIDNEY = U("5101");
const ALEX = U("5102");
const OTHER_ACTIVE = U("5103");
const OTHER_INACTIVE = U("5104");
const OWNER = U("5105");
const COMPANY = U("c001");
const PROPERTY = U("f001");

const STAGE = {
  opportunity: U("5701"),
  estimating: U("5702"),
  legacyEstimating: U("5703"),
  sent: U("5704"),
  won: U("5705"),
  legacyWon: U("5706"),
  lost: U("5707"),
  transitionalWonMapped: U("5708"),
};

const DEAL = {
  sidneyCanonical: U("d001"),
  sidneyLegacy: U("d002"),
  sidneyOwnerless: U("d003"),
  alexService: U("d004"),
  otherActive: U("d005"),
  otherInactive: U("d006"),
  missingOpportunity: U("d007"),
  missingLegacy: U("d008"),
  missingService: U("d009"),
  wonSidney: U("d101"),
  wonAlexBidBoard: U("d102"),
  wonOtherLegacy: U("d103"),
  wonMissing: U("d104"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      email text,
      display_name text,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE properties (id uuid PRIMARY KEY, name text);
    CREATE TABLE pipeline_stage_config (
      id uuid PRIMARY KEY,
      slug text UNIQUE NOT NULL,
      name text NOT NULL,
      display_order integer NOT NULL,
      is_terminal boolean NOT NULL DEFAULT false
    );
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      deal_number text,
      project_number text,
      name text NOT NULL,
      stage_id uuid NOT NULL,
      assigned_rep_id uuid,
      estimator_user_id uuid,
      company_id uuid,
      property_id uuid,
      workflow_route text NOT NULL DEFAULT 'normal',
      bid_board_stage_slug text,
      stage_entered_at timestamptz,
      bid_board_stage_entered_at timestamptz,
      on_hold_started_at timestamptz,
      on_hold_accumulated_seconds numeric NOT NULL DEFAULT 0,
      on_hold_accumulated_seconds_at_stage_entry numeric,
      expected_close_date date,
      won_closed_date date,
      awarded_amount numeric,
      bid_board_total_sales numeric,
      bid_estimate numeric,
      dd_estimate numeric,
      estimator text,
      bid_board_estimator text,
      is_bid_board_owned boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false,
      is_change_order boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false
    );

    INSERT INTO users (id, email, display_name, is_active) VALUES
      ('${SIDNEY}', 'SGibson@TRockGC.com', 'Sidney Gibson', true),
      ('${ALEX}', 'akoch@trockgc.com', 'Alex Koch', true),
      ('${OTHER_ACTIVE}', 'other.active@example.com', 'Other Active', true),
      ('${OTHER_INACTIVE}', 'other.inactive@example.com', 'Other Inactive', false),
      ('${OWNER}', 'owner@example.com', 'Project Owner', true);

    INSERT INTO companies (id, name) VALUES ('${COMPANY}', 'Acme Construction');
    INSERT INTO properties (id, name) VALUES ('${PROPERTY}', 'River Center');
    INSERT INTO pipeline_stage_config (id, slug, name, display_order, is_terminal) VALUES
      ('${STAGE.opportunity}', 'opportunity', 'Opportunity', 1, false),
      ('${STAGE.estimating}', 'estimating', 'Estimating', 2, false),
      ('${STAGE.legacyEstimating}', 'estimate_in_progress', 'Old Estimating', 2, false),
      ('${STAGE.sent}', 'estimate_sent_to_client', 'Estimate Sent to Client', 4, false),
      ('${STAGE.won}', 'won', 'Won', 7, true),
      ('${STAGE.legacyWon}', 'closed_won', 'Legacy Won', 7, true),
      ('${STAGE.lost}', 'lost', 'Lost', 8, true),
      ('${STAGE.transitionalWonMapped}', 'in_production', 'In Production', 6, true);

    -- Reportable target-estimator projects. The historical alias must merge into Sidney's canonical
    -- Estimating cell, and an ownerless deal must remain in both the headline and evidence.
    INSERT INTO deals (
      id, deal_number, project_number, name, stage_id, assigned_rep_id, estimator_user_id,
      company_id, property_id, workflow_route, stage_entered_at, expected_close_date, bid_estimate
    ) VALUES
      ('${DEAL.sidneyCanonical}', 'E-101', 'P-101', 'Sidney canonical', '${STAGE.estimating}', '${OWNER}', '${SIDNEY}', '${COMPANY}', '${PROPERTY}', 'normal', '2026-07-01T12:00:00Z', '2026-08-01', 100),
      ('${DEAL.sidneyLegacy}', 'E-102', 'P-102', 'Sidney historical alias', '${STAGE.legacyEstimating}', '${OWNER}', '${SIDNEY}', '${COMPANY}', '${PROPERTY}', 'normal', '2026-07-02T12:00:00Z', '2026-08-02', 50),
      ('${DEAL.sidneyOwnerless}', 'E-103', 'P-103', 'Sidney ownerless', '${STAGE.estimating}', NULL, '${SIDNEY}', NULL, NULL, 'normal', '2026-07-03T12:00:00Z', NULL, 25);

    -- A bare Bid Board "estimating" stage on the service route canonicalizes to service_estimating.
    INSERT INTO deals (
      id, deal_number, project_number, name, stage_id, assigned_rep_id, estimator_user_id,
      workflow_route, bid_board_stage_slug, stage_entered_at, bid_board_stage_entered_at, bid_estimate, is_bid_board_owned
    ) VALUES
      ('${DEAL.alexService}', 'E-201', 'P-201', 'Alex service estimate', '${STAGE.opportunity}', '${OWNER}', '${ALEX}', 'service', 'estimating', '2020-07-04T12:00:00Z', now(), 200, true);

    INSERT INTO deals (
      id, deal_number, project_number, name, stage_id, assigned_rep_id, estimator_user_id,
      workflow_route, stage_entered_at, bid_estimate
    ) VALUES
      ('${DEAL.otherActive}', 'E-301', 'P-301', 'Other active estimator', '${STAGE.sent}', '${OWNER}', '${OTHER_ACTIVE}', 'normal', '2026-07-05T12:00:00Z', 300),
      ('${DEAL.otherInactive}', 'E-302', 'P-302', 'Other inactive estimator', '${STAGE.sent}', '${OWNER}', '${OTHER_INACTIVE}', 'normal', '2026-07-06T12:00:00Z', 40);

    -- Missing-assignment projects cover non-actionable, unmapped legacy, and explicit unassigned labels.
    INSERT INTO deals (
      id, deal_number, project_number, name, stage_id, assigned_rep_id, estimator_user_id,
      workflow_route, bid_board_stage_slug, stage_entered_at, bid_estimate,
      estimator, bid_board_estimator, is_bid_board_owned
    ) VALUES
      ('${DEAL.missingOpportunity}', 'E-401', 'P-401', 'Missing before estimating', '${STAGE.opportunity}', '${OWNER}', NULL, 'normal', NULL, '2026-07-07T12:00:00Z', 10.10, NULL, NULL, false),
      ('${DEAL.missingLegacy}', 'E-402', 'P-402', 'Missing unmapped legacy', '${STAGE.estimating}', '${OWNER}', NULL, 'normal', NULL, '2026-07-08T12:00:00Z', 0.10, NULL, '  Legacy   Person  ', false),
      ('${DEAL.missingService}', 'E-403', 'P-403', 'Missing service estimator', '${STAGE.opportunity}', '${OWNER}', NULL, 'service', 'estimating', '2026-07-09T12:00:00Z', 0.20, 'Not Assigned', NULL, true);

    -- Won YTD is a separate realized cohort. The Sidney row's far-future forecast date proves Won uses the
    -- awarded-first realized basis rather than the open value helper, which would auto-zero it.
    INSERT INTO deals (
      id, deal_number, project_number, name, stage_id, assigned_rep_id, estimator_user_id,
      workflow_route, bid_board_stage_slug, stage_entered_at, expected_close_date, won_closed_date,
      awarded_amount, bid_estimate, bid_board_estimator, is_bid_board_owned
    ) VALUES
      ('${DEAL.wonSidney}', 'W-101', 'PW-101', 'Sidney Won from boundary', '${STAGE.won}', '${OWNER}', '${SIDNEY}', 'normal', NULL, '2026-01-01T12:00:00Z', '2099-12-31', '2026-01-01', 1000, 1, NULL, false),
      ('${DEAL.wonAlexBidBoard}', 'W-201', 'PW-201', 'Alex Bid Board Won to boundary', '${STAGE.opportunity}', '${OWNER}', '${ALEX}', 'normal', 'won', '2020-01-01T12:00:00Z', NULL, '2026-07-13', 2000, 2, NULL, true),
      ('${DEAL.wonOtherLegacy}', 'W-301', 'PW-301', 'Other legacy Won', '${STAGE.legacyWon}', '${OWNER}', '${OTHER_ACTIVE}', 'normal', NULL, '2026-04-15T12:00:00Z', NULL, '2026-04-15', 3000, 3, NULL, false),
      ('${DEAL.wonMissing}', 'W-401', 'PW-401', 'Missing estimator Won', '${STAGE.won}', '${OWNER}', NULL, 'normal', NULL, '2026-06-01T12:00:00Z', NULL, '2026-06-01', 4000, 4, 'Not Assigned', false);

    -- A CRM-owned row may retain an obsolete mirror timestamp. Its displayed age must still use the CRM
    -- stage entry, while the Bid Board-owned Alex row above must use its fresh mirror stage entry.
    UPDATE deals
    SET stage_entered_at = now(), bid_board_stage_entered_at = '2000-01-01T12:00:00Z'
    WHERE id = '${DEAL.sidneyCanonical}';

    -- Every open-scope exclusion is worth 999, making leaks obvious in either count or value.
    INSERT INTO deals (
      id, deal_number, name, stage_id, assigned_rep_id, estimator_user_id, stage_entered_at,
      bid_estimate, is_active, is_test_data, is_change_order, on_hold, bid_board_stage_slug
    ) VALUES
      ('${U("e001")}', 'X-1', 'Inactive project', '${STAGE.estimating}', '${OWNER}', '${SIDNEY}', now(), 999, false, false, false, false, NULL),
      ('${U("e002")}', 'X-2', 'Test project', '${STAGE.estimating}', '${OWNER}', '${SIDNEY}', now(), 999, true, true, false, false, NULL),
      ('${U("e003")}', 'X-3', 'Change order', '${STAGE.estimating}', '${OWNER}', '${SIDNEY}', now(), 999, true, false, true, false, NULL),
      ('${U("e004")}', 'X-4', 'Held project', '${STAGE.estimating}', '${OWNER}', '${SIDNEY}', now(), 999, true, false, false, true, NULL);

    -- Won exclusions cover both YTD boundaries, missing dates, Lost signals, the transitional aliases that
    -- canonicalize to Won for display but are not genuine Won, and every shared base-project guard.
    INSERT INTO deals (
      id, deal_number, name, stage_id, assigned_rep_id, estimator_user_id, workflow_route,
      bid_board_stage_slug, stage_entered_at, expected_close_date, won_closed_date, awarded_amount,
      is_bid_board_owned, is_active, is_test_data, is_change_order, on_hold
    ) VALUES
      ('${U("e101")}', 'WX-1', 'Won before YTD', '${STAGE.won}', '${OWNER}', '${SIDNEY}', 'normal', NULL, now(), NULL, '2025-12-31', 9999, false, true, false, false, false),
      ('${U("e102")}', 'WX-2', 'Won after report today', '${STAGE.won}', '${OWNER}', '${SIDNEY}', 'normal', NULL, now(), NULL, '2026-07-14', 9999, false, true, false, false, false),
      ('${U("e103")}', 'WX-3', 'Won without canonical date', '${STAGE.won}', '${OWNER}', '${SIDNEY}', 'normal', NULL, now(), NULL, NULL, 9999, false, true, false, false, false),
      ('${U("e104")}', 'WX-4', 'CRM Lost is not Won', '${STAGE.lost}', '${OWNER}', '${SIDNEY}', 'normal', NULL, now(), NULL, '2026-06-15', 9999, false, true, false, false, false),
      ('${U("e105")}', 'WX-5', 'Bid Board Lost is not Won', '${STAGE.opportunity}', '${OWNER}', '${SIDNEY}', 'normal', 'lost', now(), NULL, '2026-06-15', 9999, true, true, false, false, false),
      ('${U("e106")}', 'WX-6', 'Transitional mapping is not genuine Won', '${STAGE.transitionalWonMapped}', '${OWNER}', '${SIDNEY}', 'normal', NULL, now(), NULL, '2026-06-15', 9999, false, true, false, false, false),
      ('${U("e107")}', 'WX-7', 'Soft-deleted Won', '${STAGE.won}', '${OWNER}', '${SIDNEY}', 'normal', NULL, now(), NULL, '2026-06-15', 9999, false, false, false, false, false),
      ('${U("e108")}', 'WX-8', 'Test Won', '${STAGE.won}', '${OWNER}', '${SIDNEY}', 'normal', NULL, now(), NULL, '2026-06-15', 9999, false, true, true, false, false),
      ('${U("e109")}', 'WX-9', 'Change-order Won', '${STAGE.won}', '${OWNER}', '${SIDNEY}', 'normal', NULL, now(), NULL, '2026-06-15', 9999, false, true, false, true, false),
      ('${U("e110")}', 'WX-10', 'Held Won', '${STAGE.won}', '${OWNER}', '${SIDNEY}', 'normal', NULL, now(), NULL, '2026-06-15', 9999, false, true, false, false, true);
  `);
  tenantDb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

function byStage(stages: Array<{ stageSlug: string; count: number; value: number }>) {
  return new Map(stages.map((stage) => [stage.stageSlug, stage]));
}

describe("estimator pipeline summary and evidence", () => {
  it("serializes report queries on the transaction-bound tenant client", async () => {
    let callIndex = 0;
    let activeQueries = 0;
    let maximumConcurrentQueries = 0;
    const results = [
      [
        { id: SIDNEY, email: "sgibson@trockgc.com", display_name: "Sidney Gibson", is_active: true },
        { id: ALEX, email: "akoch@trockgc.com", display_name: "Alex Koch", is_active: true },
      ],
      [],
      [],
    ];
    const transactionBoundDb = {
      execute: async () => {
        const result = results[callIndex++] ?? [];
        activeQueries += 1;
        maximumConcurrentQueries = Math.max(maximumConcurrentQueries, activeQueries);
        await Promise.resolve();
        activeQueries -= 1;
        return result;
      },
    };

    const report = await getEstimatorPipelineReport(transactionBoundDb as typeof tenantDb, REPORT_NOW);

    expect(callIndex).toBe(3);
    expect(maximumConcurrentQueries).toBe(1);
    expect(report.pipeline).toEqual({ count: 0, value: 0 });
    expect(report.won).toEqual({ count: 0, value: 0 });
  });

  it("partitions the open-project cohort exactly once and merges canonical stage aliases", async () => {
    const report = await getEstimatorPipelineReport(tenantDb, REPORT_NOW);
    const sidney = report.estimators.find((estimator) => estimator.key === "sidney_gibson")!;
    const alex = report.estimators.find((estimator) => estimator.key === "alex_koch")!;

    expect(report.pipeline).toEqual({ count: 9, value: 725.4 });
    expect(report.won).toEqual({ count: 4, value: 10000 });
    expect(report.wonPeriod).toEqual({ from: "2026-01-01", to: "2026-07-13", label: "Won YTD" });
    expect(report.valueBasisLabel).toBe("Best current estimate");
    expect(report.valueBasisLabels).toEqual({
      open: "Best current estimate",
      won: "Awarded-first won value",
    });
    expect(report.scope.cohort).toBe("current_open_pipeline_plus_won_ytd");
    expect(sidney).toMatchObject({
      estimatorUserId: SIDNEY,
      estimatorName: "Sidney Gibson",
      resolved: true,
      active: true,
      count: 3,
      value: 175,
      won: { count: 1, value: 1000 },
    });
    expect(alex).toMatchObject({
      count: 1,
      value: 200,
      estimatorUserId: ALEX,
      won: { count: 1, value: 2000 },
    });
    expect(report.otherAssigned).toMatchObject({
      count: 2,
      value: 340,
      won: { count: 1, value: 3000 },
    });
    expect(report.missingEstimator).toMatchObject({
      count: 3,
      value: 10.4,
      actionableCount: 2,
      actionableValue: 0.3,
      won: { count: 1, value: 4000 },
    });

    expect(
      sidney.count + alex.count + report.otherAssigned.count + report.missingEstimator.count,
    ).toBe(report.pipeline.count);
    expect(
      sidney.value + alex.value + report.otherAssigned.value + report.missingEstimator.value,
    ).toBe(report.pipeline.value);
    expect(
      sidney.won.count + alex.won.count + report.otherAssigned.won.count + report.missingEstimator.won.count,
    ).toBe(report.won.count);
    expect(
      sidney.won.value + alex.won.value + report.otherAssigned.won.value + report.missingEstimator.won.value,
    ).toBe(report.won.value);

    const columns = byStage(report.stageColumns.map((stage) => ({ ...stage, count: 0, value: 0 })));
    expect(new Set(columns.keys())).toEqual(
      new Set(["opportunity", "estimating", "service_estimating", "estimate_sent_to_client"]),
    );
    expect(report.stageColumns.map((stage) => stage.stageSlug)).toEqual([
      "opportunity",
      "estimating",
      "service_estimating",
      "estimate_sent_to_client",
    ]);

    const allStages = byStage(
      [sidney, alex, report.otherAssigned, report.missingEstimator]
        .flatMap((bucket) => bucket.stages)
        .reduce<Array<{ stageSlug: string; count: number; value: number }>>((merged, stage) => {
          const existing = merged.find((item) => item.stageSlug === stage.stageSlug);
          if (existing) {
            existing.count += stage.count;
            existing.value += stage.value;
          } else {
            merged.push({ stageSlug: stage.stageSlug, count: stage.count, value: stage.value });
          }
          return merged;
        }, []),
    );
    expect(allStages.get("opportunity")).toMatchObject({ count: 1, value: 10.1 });
    expect(allStages.get("estimating")).toMatchObject({ count: 4, value: 175.1 });
    expect(allStages.get("service_estimating")).toMatchObject({ count: 2, value: 200.2 });
    expect(allStages.get("estimate_sent_to_client")).toMatchObject({ count: 2, value: 340 });
    expect(sidney.stages).toEqual([
      expect.objectContaining({ stageSlug: "estimating", stageLabel: "Estimating", count: 3, value: 175 }),
    ]);
  });

  it("reconciles target, other, and missing evidence to their summary buckets", async () => {
    const report = await getEstimatorPipelineReport(tenantDb, REPORT_NOW);
    const sidneySummary = report.estimators.find((estimator) => estimator.key === "sidney_gibson")!;
    const sidney = await getEstimatorPipelineEvidence(tenantDb, {
      bucket: "target",
      estimatorKey: "sidney_gibson",
      pageSize: 100,
    });
    const alex = await getEstimatorPipelineEvidence(tenantDb, {
      bucket: "target",
      estimatorKey: "alex_koch",
      pageSize: 100,
    });
    const other = await getEstimatorPipelineEvidence(tenantDb, { bucket: "other", pageSize: 100 });
    const missing = await getEstimatorPipelineEvidence(tenantDb, { bucket: "missing", pageSize: 100 });

    expect(sidney.total).toEqual({ count: sidneySummary.count, value: sidneySummary.value });
    expect(alex.total).toEqual({ count: 1, value: 200 });
    expect(other.total).toEqual({ count: report.otherAssigned.count, value: report.otherAssigned.value });
    expect(missing.total).toEqual({
      count: report.missingEstimator.count,
      value: report.missingEstimator.value,
    });
    expect([...sidney.records, ...alex.records, ...other.records, ...missing.records]).toHaveLength(
      report.pipeline.count,
    );

    expect(sidney.filter).toMatchObject({
      cohort: "open",
      bucket: "target",
      estimatorKey: "sidney_gibson",
      estimatorName: "Sidney Gibson",
      valueBasisLabel: "Best current estimate",
      period: null,
    });
    expect(sidney.records.find((record) => record.dealId === DEAL.sidneyOwnerless)).toMatchObject({
      ownerId: null,
      ownerName: "Unassigned",
      stageSlug: "estimating",
      assignmentIssue: "none",
    });
    expect(sidney.records.find((record) => record.dealId === DEAL.sidneyCanonical)).toMatchObject({
      companyName: "Acme Construction",
      propertyName: "River Center",
      expectedCloseDate: "2026-08-01",
      wonClosedDate: null,
      daysInStage: 0,
    });
    expect(alex.records[0]).toMatchObject({
      dealId: DEAL.alexService,
      stageSlug: "service_estimating",
      stageLabel: "Service Estimating",
      daysInStage: 0,
    });

    expect(other.records.find((record) => record.dealId === DEAL.otherActive)?.assignmentIssue).toBe("none");
    expect(other.records.find((record) => record.dealId === DEAL.otherInactive)).toMatchObject({
      estimatorName: "Other Inactive",
      estimatorActive: false,
      assignmentIssue: "inactive_estimator",
    });
    expect(missing.records.map((record) => record.dealNumber).sort()).toEqual(["E-401", "E-402", "E-403"]);
  });

  it("reconciles genuine CRM and Bid Board Won-YTD evidence without changing the open cohort", async () => {
    const report = await getEstimatorPipelineReport(tenantDb, REPORT_NOW);
    const sidneySummary = report.estimators.find((estimator) => estimator.key === "sidney_gibson")!;
    const alexSummary = report.estimators.find((estimator) => estimator.key === "alex_koch")!;
    const wonOptions = { cohort: "won" as const, pageSize: 100, now: REPORT_NOW };
    const sidney = await getEstimatorPipelineEvidence(tenantDb, {
      ...wonOptions,
      bucket: "target",
      estimatorKey: "sidney_gibson",
    });
    const alex = await getEstimatorPipelineEvidence(tenantDb, {
      ...wonOptions,
      bucket: "target",
      estimatorKey: "alex_koch",
    });
    const other = await getEstimatorPipelineEvidence(tenantDb, { ...wonOptions, bucket: "other" });
    const missing = await getEstimatorPipelineEvidence(tenantDb, { ...wonOptions, bucket: "missing" });

    expect(sidney.total).toEqual(sidneySummary.won);
    expect(alex.total).toEqual(alexSummary.won);
    expect(other.total).toEqual(report.otherAssigned.won);
    expect(missing.total).toEqual(report.missingEstimator.won);
    expect(
      sidney.total.count + alex.total.count + other.total.count + missing.total.count,
    ).toBe(report.won.count);
    expect(
      sidney.total.value + alex.total.value + other.total.value + missing.total.value,
    ).toBe(report.won.value);

    const records = [...sidney.records, ...alex.records, ...other.records, ...missing.records];
    expect(records).toHaveLength(4);
    expect(new Set(records.map((record) => record.dealId)).size).toBe(4);
    expect(records.map((record) => record.dealNumber).sort()).toEqual(["W-101", "W-201", "W-301", "W-401"]);
    expect(records.every((record) => record.stageSlug === "won")).toBe(true);

    expect(sidney.filter).toMatchObject({
      cohort: "won",
      valueBasisLabel: "Awarded-first won value",
      period: { from: "2026-01-01", to: "2026-07-13", label: "Won YTD" },
    });
    expect(sidney.records[0]).toMatchObject({
      dealId: DEAL.wonSidney,
      stageSlug: "won",
      stageLabel: "Won",
      expectedCloseDate: "2099-12-31",
      wonClosedDate: "2026-01-01",
      pipelineValue: 1000,
    });
    expect(alex.records[0]).toMatchObject({
      dealId: DEAL.wonAlexBidBoard,
      stageSlug: "won",
      wonClosedDate: "2026-07-13",
      pipelineValue: 2000,
      isBidBoardOwned: true,
    });

    const carriedEarlierPeriod = await getEstimatorPipelineEvidence(tenantDb, {
      cohort: "won",
      asOf: "2026-07-12",
      bucket: "target",
      estimatorKey: "alex_koch",
      pageSize: 100,
      now: REPORT_NOW,
    });
    expect(carriedEarlierPeriod.filter.period).toEqual({
      from: "2026-01-01",
      to: "2026-07-12",
      label: "Won YTD",
    });
    expect(carriedEarlierPeriod.total).toEqual({ count: 0, value: 0 });
    expect(other.records[0]).toMatchObject({
      dealId: DEAL.wonOtherLegacy,
      stageSlug: "won",
      pipelineValue: 3000,
    });
    expect(missing.records[0]).toMatchObject({
      dealId: DEAL.wonMissing,
      assignmentIssue: "unassigned",
      pipelineValue: 4000,
    });

    const wonCell = await getEstimatorPipelineEvidence(tenantDb, {
      ...wonOptions,
      bucket: "target",
      estimatorKey: "sidney_gibson",
      stageSlug: "won",
    });
    expect(wonCell.total).toEqual(sidneySummary.won);
    expect(wonCell.filter.stageLabel).toBe("Won");

    const excludedNumbers = new Set([
      "WX-1",
      "WX-2",
      "WX-3",
      "WX-4",
      "WX-5",
      "WX-6",
      "WX-7",
      "WX-8",
      "WX-9",
      "WX-10",
    ]);
    expect(records.some((record) => excludedNumbers.has(record.dealNumber ?? ""))).toBe(false);
    // Won rows never leak back into the current-open total or stage columns.
    expect(report.pipeline).toEqual({ count: 9, value: 725.4 });
    expect(report.stageColumns.some((stage) => stage.stageSlug === "won")).toBe(false);
    // Missing-Won is tracked separately and does not alter the open actionable queue.
    expect(report.missingEstimator).toMatchObject({ actionableCount: 2, actionableValue: 0.3 });
  });

  it("filters after canonicalization, classifies assignment gaps, and paginates filtered rows", async () => {
    const normalEstimating = await getEstimatorPipelineEvidence(tenantDb, {
      bucket: "missing",
      stageSlug: "estimating",
      pageSize: 100,
    });
    expect(normalEstimating.total).toEqual({ count: 1, value: 0.1 });
    expect(normalEstimating.filter).toMatchObject({
      stageSlug: "estimating",
      stageLabel: "Estimating",
    });
    expect(normalEstimating.records[0]).toMatchObject({
      dealId: DEAL.missingLegacy,
      legacyEstimatorName: "Legacy   Person",
      assignmentIssue: "unmapped_legacy",
    });

    const serviceEstimating = await getEstimatorPipelineEvidence(tenantDb, {
      bucket: "missing",
      stageSlug: "service_estimating",
      pageSize: 100,
    });
    expect(serviceEstimating.total).toEqual({ count: 1, value: 0.2 });
    expect(serviceEstimating.records[0]).toMatchObject({
      dealId: DEAL.missingService,
      stageLabel: "Service Estimating",
      workflowRoute: "service",
      assignmentIssue: "unassigned",
      isBidBoardOwned: true,
    });

    const firstPage = await getEstimatorPipelineEvidence(tenantDb, {
      bucket: "missing",
      page: 1,
      pageSize: 2,
    });
    const clampedLastPage = await getEstimatorPipelineEvidence(tenantDb, {
      bucket: "missing",
      page: 999,
      pageSize: 2,
    });
    expect(firstPage.pagination).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(firstPage.records).toHaveLength(2);
    expect(clampedLastPage.pagination).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect(clampedLastPage.records).toHaveLength(1);
    expect(clampedLastPage.total).toEqual({ count: 3, value: 10.4 });
  });
});
