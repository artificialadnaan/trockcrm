import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * The canonical platform-wide deal date-scoping model (shared, adopted by every
 * list surface). Won->won date, Lost->lost date, open->stage entry (flag-gated).
 */

import {
  buildDealOutcomeDateScope,
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

  it("windows Won rows on the signed date and Lost rows on lost_at", () => {
    const sql = render(buildDealOutcomeDateScope({ from: "2026-01-01", to: "2026-03-31" }, ctx));
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

  it("fails loudly when a date window is requested but NO won/lost stages resolve", () => {
    // Both sets empty would make openMatch = NOT(false OR false) = TRUE, silently
    // returning every row and ignoring the window (out-of-window Won/Lost rows
    // leaking in as 'open'). That is a stage-config failure, not user input — so
    // the canonical function throws rather than silently mis-filtering. (Codex #546.)
    expect(() =>
      buildDealOutcomeDateScope({ from: "2026-01-01" }, { wonStageIds: [], lostStageIds: [] })
    ).toThrow(/won.*lost|stage/i);
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
    expect(sql).toContain("d.contract_signed_at");
    expect(sql).toContain("d.lost_at");
  });
});
