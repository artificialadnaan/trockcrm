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

  it("degrades to a false sentinel (never IN ()) when stage classification is empty", () => {
    const sql = render(buildDealOutcomeDateScope({ from: "2026-01-01" }, { wonStageIds: [], lostStageIds: [] }));
    expect(sql).not.toContain("in ()");
    expect(sql).toContain("false");
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
