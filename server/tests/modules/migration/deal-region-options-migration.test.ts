import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("0136_deal_region_options migration", () => {
  const migrationSql = readFileSync(
    resolve(import.meta.dirname, "../../../../migrations/0136_deal_region_options.sql"),
    "utf8"
  );

  it("offers exactly the three new active deal region options", () => {
    expect(migrationSql).toContain("'West Coast', 'west_coast'");
    expect(migrationSql).toContain("'Central', 'central'");
    expect(migrationSql).toContain("'East Coast', 'east_coast'");
    expect(migrationSql).toContain("ON CONFLICT (slug) DO UPDATE");
    expect(migrationSql).not.toContain("'Texas', 'texas'");
    expect(migrationSql).not.toContain("'Southeast', 'southeast'");
  });

  it("deactivates legacy options instead of deleting them", () => {
    expect(migrationSql).toContain("UPDATE public.region_config");
    expect(migrationSql).toContain("SET is_active = false");
    expect(migrationSql).toContain("WHERE slug IN ('texas', 'southeast')");
    expect(migrationSql).not.toMatch(/DELETE\s+FROM\s+public\.region_config/i);
  });
});
