import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildContactIsPrimarySql, buildContactLinkedDealsCountSql } from "../../../src/modules/contacts/service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

describe("contact association select SQL", () => {
  const dialect = new PgDialect();

  it("renders a valid EXISTS subquery for primary contact flags", () => {
    const query = dialect.sqlToQuery(buildContactIsPrimarySql());

    expect(query.sql).toContain("EXISTS");
    expect(query.sql).toContain("SELECT 1");
    expect(query.sql).toContain("FROM contact_deal_associations");
    expect(query.sql).not.toContain("EXISTS ( FROM");
  });

  it("renders linked deal counts as a scalar COUNT subquery", () => {
    const query = dialect.sqlToQuery(buildContactLinkedDealsCountSql());

    expect(query.sql).toContain("SELECT COUNT(*)::int");
    expect(query.sql).toContain("FROM contact_deal_associations");
    expect(query.sql).toContain("INNER JOIN deals");
  });
});
