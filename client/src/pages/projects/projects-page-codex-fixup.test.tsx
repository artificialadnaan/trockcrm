import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source-string assertions that pin three Codex fix-up behaviors to the
// projects page. These intentionally do NOT render the component — they
// guard the wiring at the source level so a refactor that drops the
// guards cannot silently regress (the regressions cost the page going
// blank on a counts-endpoint failure, or pagination stuck on a page
// index that has no equivalent in the toggled view).
const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./projects-page.tsx"),
  "utf8",
);

describe("projects page — Codex fix-up wiring", () => {
  describe("counts endpoint failure must not break the page", () => {
    it("wraps the /projects/counts call in .catch so a 4xx/5xx/network failure resolves to null", () => {
      // Pattern B from the track playbook: counts is in the Promise.all
      // but with an inline .catch that returns null. This is what keeps
      // the Kanban + list rendering when counts blows up.
      expect(source).toMatch(
        /api<ProjectCounts>\(`\/projects\/counts`\)\.catch\(/,
      );
    });

    it("logs the counts failure via console.warn (not error) so it is visible without alarming", () => {
      expect(source).toContain('console.warn("Failed to load project counts');
    });

    it("counts catch handler returns null so setCounts(null) flows through", () => {
      // The catch arm must return null (not undefined, not a fake
      // ProjectCounts), so the metric cards fall through to the "—"
      // placeholder rather than rendering zeros that look like real data.
      const countsCatch = source.match(
        /api<ProjectCounts>\(`\/projects\/counts`\)\.catch\(\([^)]*\)\s*=>\s*\{[\s\S]*?return\s+(\w+);[\s\S]*?\}\)/,
      );
      expect(countsCatch?.[1]).toBe("null");
    });

    it("active-projects metric card renders an em-dash fallback when counts is null", () => {
      // Without this, counts?.active ?? 0 silently displays "0", which
      // is indistinguishable from a real CRM with zero active projects.
      // The em-dash makes the degraded state legible.
      expect(source).toContain('value={counts ? String(counts.active) : "—"}');
    });

    it("inactive metric card renders an em-dash fallback when counts is null", () => {
      expect(source).toContain('value={counts ? String(counts.inactive) : "—"}');
    });

    it("badges show 'Counts unavailable' fallback when counts is null", () => {
      expect(source).toContain('"Counts unavailable"');
    });
  });

  describe("active/inactive toggle resets pagination", () => {
    it("setIncludeInactive calls setPage(1) after writing the URL param", () => {
      // The toggle flips between two lists with very different page
      // counts (~7 active pages vs ~16 mixed pages). Preserving the
      // current page number on toggle yields an empty table that looks
      // like data loss. Mirror the setPage(1) reset that every other
      // filter setter does.
      const setIncludeInactive = source.match(
        /const setIncludeInactive = \(next: boolean\) => \{[\s\S]*?\};/,
      );
      expect(setIncludeInactive).not.toBeNull();
      expect(setIncludeInactive?.[0]).toContain("setPage(1)");
    });

    it("setIncludeInactive resets pagination on BOTH directions of the toggle", () => {
      // setPage(1) sits outside the if/else so it fires whether next is
      // true (Active → Include-inactive) or false (Include-inactive →
      // Active). A regression that moves setPage(1) inside one branch
      // would re-introduce the half-broken behavior.
      const body = source.match(
        /const setIncludeInactive = \(next: boolean\) => \{([\s\S]*?)\};/,
      )?.[1];
      expect(body).toBeTruthy();
      const setPageCalls = (body ?? "").match(/setPage\(1\)/g) ?? [];
      expect(setPageCalls.length).toBeGreaterThanOrEqual(1);
      // And the setPage(1) call must NOT be nested inside the if (next)
      // or else branches. Crude check: the setPage(1) appears after the
      // closing brace of the if/else block.
      const afterIfElse = body?.split(/setSearchParams\(params\);/)[1] ?? "";
      expect(afterIfElse).toContain("setPage(1)");
    });
  });
});
