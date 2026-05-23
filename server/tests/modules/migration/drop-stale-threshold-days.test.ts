import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  __dirname,
  "../../../../migrations/0134_drop_pipeline_stage_stale_threshold_days.sql"
);
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

describe("drop stale threshold days migration", () => {
  it("drops the orphaned admin-configured stale threshold column idempotently", () => {
    expect(migrationSql).toContain("ALTER TABLE public.pipeline_stage_config");
    expect(migrationSql).toContain("DROP COLUMN IF EXISTS stale_threshold_days");
  });
});
