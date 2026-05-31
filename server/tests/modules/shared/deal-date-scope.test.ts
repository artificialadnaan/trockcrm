import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * The canonical platform-wide deal date-scoping model (shared, adopted by every
 * list surface). Won -> the canonical won_closed_date basis, Lost -> lost_at,
 * open -> stage entry (flag-gated). Won/Lost classification by stage-id set;
 * partial classification windows only the resolvable class (never widens).
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

  it("windows Won rows on the canonical won_closed_date basis, Lost rows on lost_at", () => {
    const sql = render(buildDealOutcomeDateScope({ from: "2026-01-01", to: "2026-03-31" }, ctx));
    expect(sql).toContain("won_closed_date");
    expect(sql).not.toContain("hs_closed_won_date");
    expect(sql).not.toContain("contract_signed");
    expect(sql).toContain("lost_at");
    expect(sql).toContain("stage_id");
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

  it("degrades gracefully (returns undefined) only when BOTH won/lost stages are empty", () => {
    expect(
      buildDealOutcomeDateScope({ from: "2026-01-01" }, { wonStageIds: [], lostStageIds: [] })
    ).toBeUndefined();
  });

  it("under PARTIAL classification keeps windowing the RESOLVED class and excludes the rest (never widens, never drops the filter)", () => {
    // Codex #546: only-Won resolved -> window Won on won_closed_date; Lost + open
    // are EXCLUDED (not folded into open with the flag off, and the whole predicate
    // is NOT dropped to all-rows). Symmetric for only-Lost.
    const wonOnly = render(
      buildDealOutcomeDateScope({ from: "2026-01-01", to: "2026-03-31" }, { wonStageIds: ["won-1"], lostStageIds: [] })
    );
    expect(wonOnly).toContain("won_closed_date");
    expect(wonOnly).not.toContain("lost_at");
    expect(wonOnly).not.toContain("stage_entered_at"); // open branch omitted (no fold-in)
    expect(wonOnly).not.toContain("in ()"); // empty set -> `false` sentinel, never IN ()

    const lostOnly = render(
      buildDealOutcomeDateScope({ from: "2026-01-01", to: "2026-03-31" }, { wonStageIds: [], lostStageIds: ["lost-1"] })
    );
    expect(lostOnly).toContain("lost_at");
    expect(lostOnly).not.toContain("won_closed_date");
    expect(lostOnly).not.toContain("in ()");
  });

  it("supports an aliased deals table for raw-SQL surfaces (board/reports reuse)", () => {
    const sql = render(
      buildDealOutcomeDateScope({ from: "2026-01-01" }, { ...ctx, columns: aliasedDealDateScopeColumns("d") })
    );
    expect(sql).toContain("d.stage_id");
    expect(sql).toContain("d.won_closed_date");
    expect(sql).toContain("d.lost_at");
  });
});

describe("dealDisplayDateExpr (display-axis companion to the filter)", () => {
  it("emits a CASE selecting the canonical won date for Won, lost date for Lost, stage entry otherwise", () => {
    const sql = render(dealDisplayDateExpr(ctx));
    expect(sql).toContain("case");
    expect(sql).toContain("won_closed_date");
    expect(sql).toContain("lost_at");
    expect(sql).toContain("stage_entered_at");
    expect(sql).toContain("stage_id");
  });

  it("uses the SAME date columns as the filter, so display-axis == filter-axis (no divergence)", () => {
    const display = render(dealDisplayDateExpr(ctx));
    const filter = render(buildDealOutcomeDateScope({ from: "2026-01-01" }, { ...ctx, stageEntryDateEnabled: true }));
    for (const axis of ["won_closed_date", "lost_at", "stage_entered_at"]) {
      expect(display).toContain(axis);
      expect(filter).toContain(axis);
    }
  });

  it("does NOT throw on empty classification (display must never crash a render)", () => {
    expect(() => dealDisplayDateExpr({ wonStageIds: [], lostStageIds: [] })).not.toThrow();
  });

  it("supports an aliased deals table for raw-SQL surfaces", () => {
    const sql = render(dealDisplayDateExpr({ ...ctx, columns: aliasedDealDateScopeColumns("d") }));
    expect(sql).toContain("d.won_closed_date");
    expect(sql).toContain("d.lost_at");
    expect(sql).toContain("d.stage_entered_at");
  });
});
