import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, "../../../../migrations/0078_geocoding_cache.sql"),
  "utf8"
);

describe("0078 geocoding cache migration", () => {
  it("creates the cache table and indexes idempotently", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.geocoding_cache");
    expect(migrationSql).toContain("PRIMARY KEY (latitude, longitude, provider)");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS geocoding_cache_cached_at_idx");
  });
});
