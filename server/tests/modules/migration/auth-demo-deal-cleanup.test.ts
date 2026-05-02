import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL("../../../../migrations/0075_soft_delete_auth_demo_deals.sql", import.meta.url),
  "utf8"
);

describe("0075_soft_delete_auth_demo_deals migration", () => {
  it("soft-deletes only the known office_dallas auth demo deal ids", () => {
    expect(migrationSql).toContain("office_dallas");
    expect(migrationSql).toContain("aaf50815-4547-2bd3-e46e-c4973c48d3ef");
    expect(migrationSql).toContain("0322c2ad-71f6-aefd-6cbe-a9a9f06310a2");
    expect(migrationSql).toContain("0ba739f4-76de-c3ae-1cf6-e13eb266113c");
    expect(migrationSql).toContain("3981af26-1fe8-1ed9-99a2-6af779974552");
    expect(migrationSql).toContain("is_active = false");
    expect(migrationSql).toContain("COALESCE(is_active, true) = true");
  });
});
