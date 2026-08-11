// @vitest-environment jsdom
//
// Two rules the drill dialog has to keep, both of which failed silently rather than loudly.
//
// 1. LINKS CARRY THE TENANT SCOPE. The evidence REQUEST is office-scoped already — api() derives
//    x-office-id from ?officeId — so a bare href on the way out is not a missing link, it is a link into a
//    DIFFERENT schema. The id either does not exist there (404) or, worse, exists and is another record.
//    Rows load fine, every link is wrong: a symptom that points nowhere near its cause. Same rule and the
//    same helper as every report deal link, so it lives here as an assertion rather than a comment.
//
// 2. THE COMBINED LIST SAYS WHAT EACH ROW IS. In `all` mode the list mixes four kinds, and a bare name
//    cannot be told apart — "Acme Roofing" is a company or a lead depending on which table it came from.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// See file-row.runtime.test.tsx — this repo renders client components with createRoot + act under jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMocks = vi.hoisted(() => ({ fetchCanvassingEvidence: vi.fn() }));

vi.mock("@/hooks/use-reports", () => ({
  fetchCanvassingEvidence: fetchMocks.fetchCanvassingEvidence,
}));

const { CanvassingEvidenceDialog } = await import("./canvassing-evidence-dialog");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const COMBINED_RESULT = {
  kind: "all" as const,
  userId: "user-ed",
  bucketStart: null,
  total: 3,
  truncated: false,
  restrictedToSelf: false,
  rows: [
    { id: "co-1", kind: "company" as const, label: "Acme Roofing", sublabel: "client", occurredAt: "2026-06-08T12:00:00.000Z", href: "/companies/co-1" },
    { id: "pr-1", kind: "property" as const, label: "Tower A", sublabel: "12 Main St, Dallas", occurredAt: "2026-06-05T12:00:00.000Z", href: "/properties/pr-1" },
    { id: "le-1", kind: "lead" as const, label: "Canvassed lead", sublabel: "new", occurredAt: "2026-06-03T12:00:00.000Z", href: "/leads/le-1" },
  ],
};

async function renderDialog(search: string, result: unknown = COMBINED_RESULT) {
  fetchMocks.fetchCanvassingEvidence.mockResolvedValue(result);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/reports/performance/canvassing-activity${search}`] },
        createElement(CanvassingEvidenceDialog, {
          target: {
            kind: "all" as const,
            userId: "user-ed",
            personName: "Edward McCarty",
            bucketStart: null,
            periodLabel: null,
            expected: 3,
          },
          bucket: "week" as const,
          dateFrom: "2026-06-01",
          dateTo: "2026-06-30",
          onClose: () => {},
        })
      )
    );
  });
  // The dialog portals into document.body, so the container alone would look empty.
  return document.body;
}

function hrefs(scope: HTMLElement) {
  return [...scope.querySelectorAll("a")].map((a) => a.getAttribute("href"));
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("CanvassingEvidenceDialog — record links", () => {
  it("carries an explicit ?officeId onto every row link", async () => {
    const body = await renderDialog("?officeId=office-atlanta");

    expect(hrefs(body)).toEqual([
      "/companies/co-1?officeId=office-atlanta",
      "/properties/pr-1?officeId=office-atlanta",
      "/leads/le-1?officeId=office-atlanta",
    ]);
  });

  it("leaves links bare when no office scope is set — the viewer's own tenant is where they resolve", async () => {
    const body = await renderDialog("");

    expect(hrefs(body)).toEqual(["/companies/co-1", "/properties/pr-1", "/leads/le-1"]);
  });

  // ?office is ReportFilterBar's display FILTER, evaluated inside the current tenant. Promoting it to a
  // tenant switch is the bug useOfficeScopeId exists to prevent, so it must not appear on these links.
  it("never synthesises an office scope from the ?office report filter", async () => {
    const body = await renderDialog("?office=atlanta");

    expect(hrefs(body)).toEqual(["/companies/co-1", "/properties/pr-1", "/leads/le-1"]);
  });
});

describe("CanvassingEvidenceDialog — the combined list", () => {
  it("labels each row with the kind it came from", async () => {
    const body = await renderDialog("?officeId=office-atlanta");
    const text = body.textContent ?? "";

    expect(text).toContain("Company");
    expect(text).toContain("Property");
    expect(text).toContain("Lead");
    expect(text).toContain("Acme Roofing");
    expect(text).toContain("Tower A");
  });

  it("reports no mismatch when the drill agrees with the cell", async () => {
    const body = await renderDialog("?officeId=office-atlanta");

    expect(body.textContent).not.toContain("where the report showed");
  });

  // The banner is the whole point of the drill: a list that quietly holds a different number of rows from
  // the figure it was opened from teaches a reader to distrust every number on the page.
  it("says so plainly when the drill and the cell disagree", async () => {
    const body = await renderDialog("?officeId=office-atlanta", { ...COMBINED_RESULT, total: 5 });

    expect(body.textContent).toContain("where the report showed");
  });
});
