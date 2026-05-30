import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function normalizedRoutesSource(): string {
  return readFileSync(resolve(__dirname, "../../../src/modules/admin/routes.ts"), "utf8")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

describe("cross-office pipeline report SQL", () => {
  it("excludes on-hold deals from cross-office value aggregates", () => {
    const source = normalizedRoutesSource();

    expect(source).toContain("count(*) filter (where is_active = true) as active_deals");
    expect(source).toContain(
      "case when is_active = true and coalesce(on_hold, false) = false and coalesce(psc.is_terminal, false) = false then coalesce"
    );
    expect(source).toContain(
      "case when is_active = true and coalesce(on_hold, false) = false and awarded_amount > 0 then awarded_amount else 0 end"
    );
  });

  it("excludes terminal (won/lost) deals from total_pipeline_value via a pipeline_stage_config join", () => {
    const source = normalizedRoutesSource();

    // The value sum joins stage config and drops terminal stages, so a LOST (or WON)
    // deal no longer leaks its preserved bid into total_pipeline_value.
    expect(source).toContain(
      "from deals left join public.pipeline_stage_config psc on psc.id = deals.stage_id"
    );
    expect(source).toContain("and coalesce(psc.is_terminal, false) = false then coalesce");

    // Scope guard: total_awarded_value is intentionally NOT terminal-filtered here
    // (awarded contract value is a won-deal concept); only the pipeline value changed.
    expect(source).toContain(
      "coalesce(on_hold, false) = false and awarded_amount > 0 then awarded_amount else 0 end"
    );
  });
});
