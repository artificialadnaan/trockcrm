/**
 * The scope title has to be searchable on the FIELD surfaces too, not just unified CRM search.
 *
 * #1051 added `deals.scope_title` to `DEAL_SEARCH_FIELDS` (unified-search.ts) and stopped there. The
 * field app does not use that predicate: the Projects page builds its own WHERE in
 * `activeProjectWhere`, and the photo-capture target picker builds another in
 * `buildPhotoTargetDealSearchCondition`. Both list the identity columns by hand, so a column added to
 * the unified set reaches neither.
 *
 * WHY THAT MATTERS MOST FOR CHANGE ORDERS. A change-order child's stored `name` is the generic
 * "<Parent> — Change Order N". The scope phrase a field user actually remembers — "Panel Relocation" —
 * is stored ONLY in `scope_title`. Without these two predicates, the deal is findable in CRM search and
 * unfindable from the two screens a person standing on the site actually has open.
 *
 * These are pure SQL-shape assertions: the builders are pure functions over a search string, so the
 * predicate can be proven without a database. Mirrors deals-search-field-set.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {} as any,
  pool: {} as any,
}));

// files/service.js reaches R2 at import time via its client module; these predicates never presign
// anything, so a stub keeps this a pure unit test (same shape capture-target-recovery-search uses).
vi.mock("../../../src/lib/r2-client.js", () => ({
  generateUploadUrl: vi.fn(),
  generateDownloadUrl: vi.fn(),
  generateMockUploadUrl: vi.fn(() => "https://mock-upload-url.com"),
  generateMockDownloadUrl: vi.fn(() => "https://mock-download-url.com"),
  headObject: vi.fn(),
  isR2Configured: vi.fn(() => false),
}));

/**
 * Walks a drizzle SQL object (queryChunks / Param / Column / Table) into a flat string so we can
 * assert on the columns a builder emits without a live database. Copied from
 * deals-search-field-set.test.ts, where it is already proven against these same builders' siblings.
 */
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

describe("activeProjectWhere — field Projects page search", () => {
  it("matches on scope_title", async () => {
    const { activeProjectWhere } = await import("../../../src/modules/field/projects-service.js");
    const text = extractSqlText(activeProjectWhere("panel relocation"));

    expect(text).toContain("scope_title");
  });

  it("keeps every identity column it already searched (superset, no regression)", async () => {
    const { activeProjectWhere } = await import("../../../src/modules/field/projects-service.js");
    const text = extractSqlText(activeProjectWhere("panel relocation"));

    // Adding a column must not displace one. project_number in particular is load-bearing for
    // HubSpot-imported deals, whose deal_number holds the HS- id instead.
    for (const column of ["name", "deal_number", "project_number", "property_address", "property_city"]) {
      expect(text).toContain(column);
    }
  });

  it("emits scope_title ONLY when there is a search term", async () => {
    const { activeProjectWhere } = await import("../../../src/modules/field/projects-service.js");

    // The five call sites that pass no term (projects-service.ts:278/345/391/437/685) build a
    // browsability filter, not a search. A column leaking out of the `normalizedSearch` branch would
    // add an unbound predicate to all of them — the failure mode is silent, so it is asserted.
    expect(extractSqlText(activeProjectWhere())).not.toContain("scope_title");
  });
});

describe("buildPhotoTargetDealSearchCondition — photo capture target picker", () => {
  it("matches on scope_title", async () => {
    const { buildPhotoTargetDealSearchCondition } = await import("../../../src/modules/files/service.js");
    const text = extractSqlText(buildPhotoTargetDealSearchCondition("panel relocation"));

    expect(text).toContain("scope_title");
  });

  it("keeps every column it already searched (superset, no regression)", async () => {
    const { buildPhotoTargetDealSearchCondition } = await import("../../../src/modules/files/service.js");
    const text = extractSqlText(buildPhotoTargetDealSearchCondition("panel relocation"));

    for (const column of [
      "name",
      "deal_number",
      "project_number",
      "description",
      "property_address",
      "property_city",
    ]) {
      expect(text).toContain(column);
    }
  });
});
