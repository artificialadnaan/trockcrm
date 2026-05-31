import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * The canonical platform-wide deal date-scoping model (shared, adopted by every
 * list surface). Won->won date, Lost->lost date, open->stage entry (flag-gated).
 */

import {
  buildDealOutcomeDateScope,
  dealDisplayDateExpr,
  aliasedDealDateScopeColumns,
} from "../../../src/modules/shared/deal-date-scope.js";

const dialect = new PgDialect();
const render = (value: SQL | undefined) => (value ? dialect.sqlToQuery(value).sql.toLowerCase() : "");
const ctx = { wonStageIds: ["won-1", "won-2"], lostStageIds: ["lost-1"] };

describe("buildDealOutcomeDateScope", () => {
  it("returns undefined when no window is set", () => {
    expect(buildDealOutcomeDateScope({}, ctx)).toBeUndefined();
    expect(buildDealOutcomeDateScope({ from: "", to: "" }, ctx)).toBeUndefined();
  });

  it("windows Won rows on the CANONICAL won-close date (basis), Lost rows on lost_at", () => {
    const sql = render(buildDealOutcomeDateScope({ from: "2026-01-01", to: "2026-03-31" }, ctx));
    // Canonical Won basis = COALESCE(NULLIF(hs_closed_won_date,'')::date,
    // contract_signed_at::date, contract_signed_date) — the SAME chain the getDeals
    // Won drill-down / getWonCloseSummary use. The hs_closed_won_date PRIMARY is
    // what makes it canonical (a bare contract_signed COALESCE diverged from basis).
    expect(sql).toContain("hs_closed_won_date");
    expect(sql).toContain("contract_signed_at");
    expect(sql).toContain("contract_signed_date");
    expect(sql).toContain("lost_at");
    expect(sql).toContain("stage_id"); // classified by stage-id membership
  });

  it("applies inclusive-from and exclusive-next-day-to bounds", () => {
    const sql = render(buildDealOutcomeDateScope({ from: "2026-01-01", to: "2026-03-31" }, ctx));
    expect(sql).toContain(">=");
    expect(sql).toContain("interval '1 day'");
  });

  it("leaves open rows current-state when the stage-entry flag is OFF", () => {
    const sql = render(buildDealOutcomeDateScope({ from: "2026-01-01" }, { ...ctx, stageEntryDateEnabled: false }));
    expect(sql).not.toContain("stage_entered_at");
  });

  it("bounds open rows by stage-entry date when the flag is ON", () => {
    const sql = render(buildDealOutcomeDateScope({ from: "2026-01-01" }, { ...ctx, stageEntryDateEnabled: true }));
    expect(sql).toContain("stage_entered_at");
  });

  it("degrades gracefully (returns undefined, skips the predicate) when NO won/lost stages resolve", () => {
    // Both sets empty is a pipeline_stage_config misconfig. Rather than 500 a
    // date-filtered endpoint, the function skips the date predicate so the caller
    // omits it and still returns rows (Codex #546 — graceful-empty guarantee).
    expect(
      buildDealOutcomeDateScope({ from: "2026-01-01" }, { wonStageIds: [], lostStageIds: [] })
    ).toBeUndefined();
  });

  it("still classifies correctly when only ONE outcome class resolves (partial config)", () => {
    const sql = render(buildDealOutcomeDateScope({ from: "2026-01-01" }, { wonStageIds: ["won-1"], lostStageIds: [] }));
    expect(sql).toContain("stage_id");
    expect(sql).not.toContain("in ()");
  });

  it("supports an aliased deals table for raw-SQL surfaces (board/reports reuse)", () => {
    const sql = render(
      buildDealOutcomeDateScope(
        { from: "2026-01-01" },
        { ...ctx, columns: aliasedDealDateScopeColumns("d") }
      )
    );
    expect(sql).toContain("d.stage_id");
    expect(sql).toContain("d.contract_signed_at"); // canonical won axis on the alias
    expect(sql).toContain("d.lost_at");
  });
});

describe("dealDisplayDateExpr (display-axis companion to the filter)", () => {
  it("emits a CASE selecting the canonical won date for Won, lost date for Lost, stage entry otherwise", () => {
    const sql = render(dealDisplayDateExpr(ctx));
    expect(sql).toContain("case");
    expect(sql).toContain("hs_closed_won_date"); // canonical won axis (basis)
    expect(sql).toContain("lost_at"); // lost axis
    expect(sql).toContain("stage_entered_at"); // open axis (ELSE)
    expect(sql).toContain("stage_id"); // classified by the same stage-id sets
  });

  it("uses the SAME date columns as the filter, so display-axis == filter-axis (no divergence)", () => {
    // Both helpers are fed the identical ctx/columns -> they reference the same
    // date columns. This is the structural guarantee behind filter == display.
    // The filter only references the open stage-entry column when the flag is on
    // (off = open rows are current-state), so assert against the flag-on filter
    // for the stage-entry axis; won/lost are always present in both.
    const display = render(dealDisplayDateExpr(ctx));
    const filter = render(buildDealOutcomeDateScope({ from: "2026-01-01" }, { ...ctx, stageEntryDateEnabled: true }));
    for (const axis of ["hs_closed_won_date", "lost_at", "stage_entered_at"]) {
      expect(display).toContain(axis);
      expect(filter).toContain(axis);
    }
  });

  it("does NOT throw on empty classification (display must never crash a render)", () => {
    expect(() => dealDisplayDateExpr({ wonStageIds: [], lostStageIds: [] })).not.toThrow();
  });

  it("supports an aliased deals table for raw-SQL surfaces", () => {
    const sql = render(dealDisplayDateExpr({ ...ctx, columns: aliasedDealDateScopeColumns("d") }));
    expect(sql).toContain("d.contract_signed_at");
    expect(sql).toContain("d.lost_at");
    expect(sql).toContain("d.stage_entered_at");
  });
});
