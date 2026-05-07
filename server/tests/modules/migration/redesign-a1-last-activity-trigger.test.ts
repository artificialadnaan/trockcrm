import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL("../../../../migrations/0090_redesign_a1_companies_contacts_properties.sql", import.meta.url),
  "utf8",
);

describe("redesign A1 last activity trigger migration", () => {
  it("schema-qualifies trigger table writes through TG_TABLE_SCHEMA instead of caller search_path", () => {
    expect(migrationSql).toContain("TG_TABLE_SCHEMA");
    expect(migrationSql).toContain("UPDATE %1$I.companies c");
    expect(migrationSql).toContain("UPDATE %1$I.properties p");
    expect(migrationSql).toContain("FROM %1$I.activities a");
  });

  it("does not leave unqualified tenant table references inside the replay trigger function", () => {
    const functionStart = migrationSql.indexOf("CREATE OR REPLACE FUNCTION refresh_redesign_last_activity()");
    const functionEnd = migrationSql.indexOf("DROP TRIGGER IF EXISTS redesign_last_activity_refresh ON activities", functionStart);
    const functionSql = migrationSql.slice(functionStart, functionEnd);

    expect(functionSql).not.toMatch(/\n\s+UPDATE companies c/);
    expect(functionSql).not.toMatch(/\n\s+UPDATE properties p/);
    expect(functionSql).not.toMatch(/\n\s+FROM activities a/);
  });
});
