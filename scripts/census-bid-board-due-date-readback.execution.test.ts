// ★ THE EXECUTION TEST. This file exists because the census suite could not tell a working query from a
// broken one.
//
// The rest of the census tests assert with `toContain` over the generated SQL. That verifies FRAGMENTS
// and is blind to the surrounding syntax: a refactor that moved prose out of the template literal
// accidentally deleted an `EXISTS (SELECT 1 FROM ... WHERE ...)` wrapper, leaving dangling `AND` clauses
// in the SELECT list — and 109 string-matching tests passed against a statement Postgres will not parse.
// Every fragment those tests looked for was still present; only the thing between them was destroyed.
//
// So this suite does the one thing string matching cannot: it hands the query to a real Postgres.
// PGlite rather than a developer's local database, so it runs in CI (`npm run test:scripts` is part of
// check:premerge) with no external dependency.
//
// The schema is derived from the REAL Drizzle table definitions (tenantSchemaSql), not hand-written, so
// this also fails if the census ever references a column that does not exist — the other half of "the
// query is wrong" that a fragment assertion cannot see.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { deals, leads, pipelineStageConfig } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../server/tests/helpers/tenant-schema-from-drizzle.js";
import { buildCensusSql } from "./census-bid-board-due-date-readback.js";

const SCHEMA = "office_dallas";
const STAGE_ID = "00000000-0000-4000-8000-0000000050a1";
const DEAL_ID = "00000000-0000-4000-8000-0000000000d1";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  // pipeline_stage_config lives in public and is read by holdHorizonDateSql's stage subselect; deals and
  // leads live in the tenant schema the census is pointed at.
  await pg.exec(tenantSchemaSql("public", [pipelineStageConfig]));
  await pg.exec(tenantSchemaSql(SCHEMA, [deals, leads]));
  await pg.query(
    `INSERT INTO public.pipeline_stage_config (id, slug, name, workflow_family, display_order)
     VALUES ($1, 'estimating', 'Estimating', 'standard_deal', 3)`,
    [STAGE_ID]
  );
}, 60_000);

afterAll(async () => {
  await pg?.close?.();
});

describe("buildCensusSql — executes against a real Postgres", () => {
  // The bare minimum this suite exists for. If the statement does not parse, everything else the census
  // reports is fiction, however many fragment assertions pass.
  it("PARSES and PLANS — the check the string-matching suite structurally cannot make", async () => {
    await expect(pg.exec(`EXPLAIN ${buildCensusSql(SCHEMA)}`)).resolves.toBeDefined();
  });

  it("runs and returns no rows against an empty tenant, without error", async () => {
    const result = await pg.query(buildCensusSql(SCHEMA));
    expect(result.rows).toEqual([]);
  });

  it("returns a candidate row with every column the summarizer reads", async () => {
    // A deal the ingest would write to: mirrored Due Date differing from the CRM column, not detached,
    // not a template, active, not a change order.
    await pg.query(
      `INSERT INTO ${SCHEMA}.deals
         (id, name, deal_number, project_number, bid_board_project_number, stage_id, assigned_rep_id,
          bid_due_date, bid_board_due_date, bid_board_status, expected_close_date, bid_board_total_sales,
          is_active, is_change_order, is_test_data)
       VALUES ($1, 'Riverbend Tower', 'DFW-1-00001-aa', 'DFW-1-00001-aa', 'DFW-1-00001-aa', $2, NULL,
               '2026-06-01T00:00:00Z', '2026-09-01', 'Estimate in Progress', '2026-10-01', 250000,
               true, false, false)`,
      [DEAL_ID, STAGE_ID]
    );

    const { rows } = await pg.query<Record<string, unknown>>(buildCensusSql(SCHEMA));
    expect(rows).toHaveLength(1);

    // Every field CensusRow declares must actually come back — a census that silently returned undefined
    // for one of these would summarize wrong rather than fail.
    for (const column of [
      "id",
      "deal_number",
      "project_number",
      "name",
      "stage_slug",
      "deal_value",
      "current_bid_due_date",
      "next_bid_due_date",
      "stored_on_hold",
      "bid_board_last_updated_at",
      "demo_shaped",
      "is_ambiguous_procore_bid_id",
      "is_ambiguous_project_number",
      "has_procore_bid_id",
      "next_bid_due_day",
      "is_test_data",
      "bid_due_date_bid_board_project_number",
      "bid_board_project_number",
      "has_source_lead",
      "lead_bid_due_date",
      "bid_due_date_from_bid_board_at",
      "value_changes",
      "from_null",
      "is_genuine_estimating",
      "is_terminal",
      "current_horizon",
      "next_horizon",
      "currently_far_out",
      "next_far_out",
    ]) {
      expect(Object.keys(rows[0]), `missing column ${column}`).toContain(column);
    }
  });

  // The two EXISTS subqueries are what the broken refactor destroyed, so prove they EVALUATE — not merely
  // that the text appears somewhere. A dangling AND would have failed to parse; a subquery wired to the
  // wrong alias would parse and quietly answer false forever.
  it("evaluates the tier-1 EXISTS: a shared procore_bid_id is detected", async () => {
    await pg.exec(`DELETE FROM ${SCHEMA}.deals;`);
    await pg.query(
      `INSERT INTO ${SCHEMA}.deals
         (id, name, deal_number, project_number, bid_board_project_number, stage_id, procore_bid_id,
          bid_due_date, bid_board_due_date, is_active, is_change_order)
       VALUES
         ($1, 'A', 'P-1', 'P-1', 'P-1', $3, 4242, '2026-06-01T00:00:00Z', '2026-09-01', true, false),
         ($2, 'B', 'P-2', 'P-2', 'P-2', $3, 4242, '2026-06-01T00:00:00Z', '2026-09-01', true, false)`,
      [DEAL_ID, "00000000-0000-4000-8000-0000000000d2", STAGE_ID]
    );

    const { rows } = await pg.query<{ is_ambiguous_procore_bid_id: boolean }>(buildCensusSql(SCHEMA));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.is_ambiguous_procore_bid_id === true)).toBe(true);
  });

  it("evaluates the tier-2 EXISTS: a shared canonical project number is detected", async () => {
    await pg.exec(`DELETE FROM ${SCHEMA}.deals;`);
    await pg.query(
      `INSERT INTO ${SCHEMA}.deals
         (id, name, deal_number, project_number, bid_board_project_number, stage_id,
          bid_due_date, bid_board_due_date, is_active, is_change_order)
       VALUES
         ($1, 'A', 'P-1', 'P-1', 'P-1', $3, '2026-06-01T00:00:00Z', '2026-09-01', true, false),
         -- Same project number in a different case/spacing: the canonicalizer must fold them together.
         ($2, 'B', 'D-9', '  p-1  ', NULL, $3, '2026-06-01T00:00:00Z', '2026-09-01', true, false)`,
      [DEAL_ID, "00000000-0000-4000-8000-0000000000d2", STAGE_ID]
    );

    const { rows } = await pg.query<{ id: string; is_ambiguous_project_number: boolean }>(
      buildCensusSql(SCHEMA)
    );
    const first = rows.find((r) => r.id === DEAL_ID);
    expect(first?.is_ambiguous_project_number).toBe(true);
  });

  it("still parses for a differently-named office schema", async () => {
    // The builder interpolates the schema name in several places; a missing one would only show up here.
    await pg.exec(tenantSchemaSql("office_atlanta", [deals, leads]));
    await expect(pg.exec(`EXPLAIN ${buildCensusSql("office_atlanta")}`)).resolves.toBeDefined();
  });
});
