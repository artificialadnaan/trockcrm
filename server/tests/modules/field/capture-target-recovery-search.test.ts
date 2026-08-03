/**
 * The RECOVERY capture-target search — the question the walkthrough recovery picker has to ask, and
 * the one neither existing question could answer.
 *
 * Two shapes collide here, both documented in the code they come from:
 *
 *   1. `searchPhotoUploadTargets` caps PER TYPE and returns leads, then opportunities, then deals
 *      (files/service.ts). Within ONE office that is safe: 20 leads never evict a deal, because the
 *      deals get their own budget.
 *   2. `mergeFieldCaptureTargets` (projects-service.ts) folds those per-office answers into ONE list
 *      ordered lead → opportunity → deal and applies ONE GLOBAL limit. That is where the per-type
 *      budgets stop protecting deals: with cross-office reads on, 20 matching leads fill the whole
 *      global slice and EVERY deal is cut.
 *
 * So the recovery picker's widened half — asked without `dealsOnly` precisely because that flag also
 * applies the browsing stage rule and would hide the Lost deal it exists to find — could come back
 * with no deals at all, while the `dealsOnly` half it is merged with cannot supply the terminal deal
 * by definition. Both halves lose the same job, for different reasons.
 *
 * The fix is `includeTerminalDeals`: keep the deals-only narrowing, drop the browsing stage rule, and
 * do the narrowing PER OFFICE — before the global cap — so the deals compete only with each other.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// files/service.js reaches R2 at import time via its client module; the picker search itself never
// presigns anything, so a stub keeps this a pure unit test (same shape photo-picker-leads uses).
vi.mock("../../../src/lib/r2-client.js", () => ({
  generateUploadUrl: vi.fn(),
  generateDownloadUrl: vi.fn(),
  generateMockUploadUrl: vi.fn(() => "https://mock-upload-url.com"),
  generateMockDownloadUrl: vi.fn(() => "https://mock-download-url.com"),
  headObject: vi.fn(),
  isR2Configured: vi.fn(() => false),
}));

const searchMock = vi.hoisted(() => vi.fn());
// Only the search is replaced: the rest of files/service is left real so nothing else in the module
// graph silently loses an export it imports.
vi.mock("../../../src/modules/files/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/files/service.js")>()),
  searchPhotoUploadTargets: searchMock,
}));

import {
  mergeFieldCaptureTargets,
  searchFieldCaptureTargets,
} from "../../../src/modules/field/projects-service.js";
import type { FieldOffice } from "../../../src/modules/field/cross-office.js";
import type { PhotoUploadTarget } from "../../../src/modules/files/service.js";

const dallas: FieldOffice = { id: "id-dallas", slug: "dallas" };
const atlanta: FieldOffice = { id: "id-atlanta", slug: "atlanta" };
const access = { userId: "rep-1", userRole: "rep" as const };
const db = {} as never; // never touched: the SQL layer is the mock
/** What the picker asks for — mobile's useCaptureTargets sends limit 20 (mobile/src/query/hooks.ts). */
const PICKER_LIMIT = 20;

function target(
  id: string,
  type: PhotoUploadTarget["type"],
  minutesAgo = 0,
  stageName: string | null = null,
): PhotoUploadTarget {
  return {
    id,
    type,
    name: id,
    recordNumber: null,
    stageName,
    companyName: null,
    lastUpdatedAt: new Date(Date.UTC(2026, 5, 20, 12, 0) - minutesAgo * 60_000),
  };
}

const LOST_DEAL = "deal-lost"; // the walked job, moved to Lost while the recording sat unfiled
const LIVE_DEAL = "deal-live"; // an ordinary browsable job matching the same search

/**
 * One office answering the REAL endpoint, faithfully — both of its documented narrowings, because it
 * is the pairing of the two that loses the job:
 *
 *   - `dealsOnly` = deals in SQL AND the BROWSING stage rule, so the Lost deal is absent from it;
 *   - unfiltered = every ACTIVE record, in per-type order: leads (own cap), then opportunities, then
 *     deals. Twenty matching leads is not a stress figure — it is exactly the picker's own limit,
 *     i.e. the smallest lead volume that fills the global slice on its own.
 */
function officeAnswer(prefix: string, input: { dealsOnly?: boolean }) {
  const deals = [
    target(`${prefix}-${LOST_DEAL}`, "deal", 40, "Bid Lost"),
    target(`${prefix}-${LIVE_DEAL}`, "deal", 50, "Estimating"),
  ];
  if (input.dealsOnly) {
    return { targets: deals.filter((t) => t.stageName !== "Bid Lost") };
  }
  return {
    targets: [
      ...Array.from({ length: PICKER_LIMIT }, (_, i) => target(`${prefix}-lead-${i}`, "lead", i)),
      target(`${prefix}-opp`, "opportunity", 30),
      ...deals,
    ],
  };
}

/** Search every office the way the cross-office route does, then merge under ONE global cap. */
async function searchAndMerge(input: Parameters<typeof searchFieldCaptureTargets>[2]) {
  const perOffice = [];
  for (const office of [dallas, atlanta]) {
    const { targets } = await searchFieldCaptureTargets(db, access, input);
    perOffice.push({ office, targets });
  }
  return mergeFieldCaptureTargets(perOffice, input?.limit ?? PICKER_LIMIT);
}

beforeEach(() => {
  searchMock.mockReset();
});

describe("recovery capture-target search (includeTerminalDeals)", () => {
  // The mechanism, stated as a test so the fix can't be read as speculative: this is what the picker's
  // widened half did before, and it is why merging it with the `dealsOnly` half still lost the job.
  // GUARD-of-the-bug (passes before AND after — it exercises the OLD input, which is unchanged).
  it("MECHANISM: the unfiltered question loses every deal once 20 leads match (global cap, lead-first order)", async () => {
    searchMock.mockImplementation(async (_db: unknown, input: { dealsOnly?: boolean }) =>
      officeAnswer("dallas", input),
    );

    const merged = await searchAndMerge({ search: "preston", limit: PICKER_LIMIT });

    expect(merged).toHaveLength(PICKER_LIMIT);
    expect(merged.every((t) => t.type === "lead")).toBe(true); // not one deal survived
  });

  it("narrows to deals PER OFFICE, so the terminal deal survives the global cap", async () => {
    searchMock.mockImplementation(async (_db: unknown, input: { dealsOnly?: boolean }) =>
      officeAnswer("dallas", input),
    );

    const merged = await searchAndMerge({
      search: "preston",
      limit: PICKER_LIMIT,
      dealsOnly: true,
      includeTerminalDeals: true,
    });

    expect(merged.every((t) => t.type === "deal")).toBe(true);
    expect(merged.map((t) => t.id)).toContain(`dallas-${LOST_DEAL}`);
    // and not by trading the ordinary jobs away for it
    expect(merged.map((t) => t.id)).toContain(`dallas-${LIVE_DEAL}`);
  });

  it("asks the underlying search WITHOUT the browsing stage rule (that rule is what hides the Lost deal)", async () => {
    searchMock.mockResolvedValue({ targets: [] });

    await searchFieldCaptureTargets(db, access, {
      search: "preston",
      limit: PICKER_LIMIT,
      dealsOnly: true,
      includeTerminalDeals: true,
    });

    expect(searchMock).toHaveBeenCalledWith(db, {
      search: "preston",
      limit: PICKER_LIMIT,
      dealsOnly: false, // = no stage predicate; `is_active` only, which is the filing rule
    });
  });

  // GUARD (passes before this change too): ORDINARY browsing must be untouched. The scorecard picker
  // asks `dealsOnly` alone and must keep getting the SQL-level, stage-filtered answer — a Lost deal
  // leaking into it would offer a project its own create gate 404s.
  it("leaves plain dealsOnly browsing on the stage-filtered SQL path", async () => {
    searchMock.mockResolvedValue({ targets: [] });

    await searchFieldCaptureTargets(db, access, { search: "preston", limit: PICKER_LIMIT, dealsOnly: true });

    expect(searchMock).toHaveBeenCalledWith(db, {
      search: "preston",
      limit: PICKER_LIMIT,
      dealsOnly: true,
    });
  });

  // GUARD: the flag is meaningless on its own — without `dealsOnly` the answer already carries every
  // active deal, and honouring it alone would silently drop the leads the ordinary picker needs.
  it("ignores includeTerminalDeals when dealsOnly is off (the unfiltered answer already includes them)", async () => {
    searchMock.mockImplementation(async (_db: unknown, input: { dealsOnly?: boolean }) =>
      officeAnswer("dallas", input),
    );

    const { targets } = await searchFieldCaptureTargets(db, access, {
      search: "preston",
      limit: PICKER_LIMIT,
      includeTerminalDeals: true,
    });

    expect(targets.some((t) => t.type === "lead")).toBe(true);
    expect(searchMock).toHaveBeenCalledWith(db, {
      search: "preston",
      limit: PICKER_LIMIT,
      dealsOnly: undefined,
    });
  });
});
