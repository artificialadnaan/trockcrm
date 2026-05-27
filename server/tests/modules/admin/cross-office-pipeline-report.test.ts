import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cross-office pipeline report SQL", () => {
  it("excludes on-hold deals from cross-office value aggregates", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../src/modules/admin/routes.ts"),
      "utf8"
    )
      .toLowerCase()
      .replace(/\s+/g, " ");

    expect(source).toContain("count(*) filter (where is_active = true) as active_deals");
    expect(source).toContain(
      "case when is_active = true and coalesce(on_hold, false) = false then coalesce"
    );
    expect(source).toContain(
      "case when is_active = true and coalesce(on_hold, false) = false and awarded_amount > 0 then awarded_amount else 0 end"
    );
  });
});
