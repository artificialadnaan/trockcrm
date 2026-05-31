import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import {
  aliasedLeadDateScopeColumns,
  buildLeadOutcomeDateScope,
  leadDateScopeColumns,
  leadDisplayDateExpr,
} from "../../../src/modules/shared/lead-date-scope.js";

const dialect = new PgDialect();
const render = (value: SQL | undefined) =>
  value ? dialect.sqlToQuery(value).sql.toLowerCase() : "";

describe("buildLeadOutcomeDateScope (SQL shape)", () => {
  it("returns undefined when the window is empty", () => {
    expect(buildLeadOutcomeDateScope({}, {})).toBeUndefined();
    expect(buildLeadOutcomeDateScope({ from: "  ", to: "" }, {})).toBeUndefined();
  });

  it("windows each lead outcome on its own date axis, keyed by status", () => {
    const q = dialect.sqlToQuery(
      buildLeadOutcomeDateScope({ from: "2026-02-01", to: "2026-02-28" }, {})!
    );
    const text = q.sql.toLowerCase();
    expect(text).toContain("converted_at");
    expect(text).toContain("disqualified_at");
    // open axis falls back to created_at when stage entry is null
    expect(text).toContain("stage_entered_at");
    expect(text).toContain("created_at");
    expect(text).toContain("coalesce");
    // each axis is gated by the lead status (compared as text so an enum column works)
    expect(text).toContain("status");
    // status values are parameterized ($1/$2/$3), not inlined as SQL literals
    expect(q.params).toContain("converted");
    expect(q.params).toContain("disqualified");
    expect(q.params).toContain("open");
  });

  it("uses an inclusive-from / exclusive-next-day-to boundary", () => {
    const text = render(buildLeadOutcomeDateScope({ from: "2026-02-01", to: "2026-02-28" }, {}));
    expect(text).toContain(">=");
    expect(text).toContain("interval '1 day'");
  });

  it("never windows the disqualified axis on stage_entered_at (no coalesce on that axis)", () => {
    const text = render(buildLeadOutcomeDateScope({ from: "2026-02-01", to: "2026-02-28" }, {}));
    // the only coalesce is the open axis (stage_entered_at -> created_at);
    // disqualified_at must stand alone
    expect(text).toContain("disqualified_at");
    expect(text).not.toContain("coalesce(\"leads\".\"disqualified_at\"");
  });

  it("aliases columns for raw-SQL queries", () => {
    const text = render(
      buildLeadOutcomeDateScope(
        { from: "2026-02-01", to: "2026-02-28" },
        { columns: aliasedLeadDateScopeColumns("l") }
      )
    );
    expect(text).toContain("l.status");
    expect(text).toContain("l.converted_at");
    expect(text).toContain("l.disqualified_at");
    expect(text).toContain("l.stage_entered_at");
    expect(text).toContain("l.created_at");
  });

  it("default (unaliased) columns reference the leads table", () => {
    const cols = leadDateScopeColumns();
    expect(render(cols.status)).toContain("status");
    expect(render(cols.convertedDate)).toContain("converted_at");
    expect(render(cols.disqualifiedDate)).toContain("disqualified_at");
    expect(render(cols.openDate)).toContain("coalesce");
  });
});

describe("leadDisplayDateExpr (SQL shape)", () => {
  it("is a CASE over the three statuses with the same axes as the filter, ELSE null", () => {
    const q = dialect.sqlToQuery(leadDisplayDateExpr({}));
    const text = q.sql.toLowerCase();
    expect(text).toContain("case");
    expect(text).toContain("converted_at");
    expect(text).toContain("disqualified_at");
    expect(text).toContain("coalesce");
    expect(text).toContain("else null");
    // status values are parameterized, not inlined
    expect(q.params).toContain("converted");
    expect(q.params).toContain("disqualified");
    expect(q.params).toContain("open");
  });
});
