import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "../../../src/modules/deals/routes.ts"),
  "utf8",
);
const routeStart = source.indexOf('router.get("/:id/scorecards/:scorecardId/download"');
const routeSource = source.slice(routeStart, routeStart + 4_000);

describe("CRM scorecard PDF download transaction boundary", () => {
  it("commits the tenant transaction before HEAD checks or on-demand regeneration", () => {
    expect(routeStart).toBeGreaterThan(-1);
    const commit = routeSource.indexOf("await req.commitTransaction!()");
    const head = routeSource.indexOf("await isStoredScorecardPdfAvailable");
    const regenerate = routeSource.indexOf("await finalizeFieldScorecardArtifacts");
    expect(commit).toBeGreaterThan(-1);
    expect(head).toBeGreaterThan(commit);
    expect(regenerate).toBeGreaterThan(commit);
  });

  it("uses retryable 503 errors and never falls back to a stale legacy key after refresh failure", () => {
    expect(routeSource).toContain("SCORECARD_PDF_REGENERATION_FAILED");
    expect(routeSource).toContain("SCORECARD_PDF_NOT_READY");
    expect(routeSource).not.toContain("presignDealScorecardPdf(req.params.scorecardId, artifact.pdfR2Key");
  });
});
