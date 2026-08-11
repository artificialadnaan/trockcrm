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
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
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

const TARGET = {
  kind: "all" as const,
  userId: "user-ed",
  personName: "Edward McCarty",
  bucketStart: null,
  periodLabel: null,
  expected: 3,
};

/**
 * Renders inside a MemoryRouter whose entries the test can push to, so an office switch is exercised as the
 * URL change it actually is rather than by re-mounting (which would hide the whole bug).
 */
/** Captured so a test can drive a real in-router navigation — an office switch is a URL change, not a remount. */
let navigate: ((to: string) => void) | null = null;

function NavigationHandle() {
  navigate = useNavigate();
  return null;
}

function tree(search: string, onClose: () => void) {
  return createElement(
    MemoryRouter,
    { initialEntries: [`/reports/performance/canvassing-activity${search}`] },
    createElement(
      Fragment,
      null,
      createElement(NavigationHandle),
      createElement(CanvassingEvidenceDialog, {
        target: TARGET,
        bucket: "week" as const,
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        onClose,
      })
    )
  );
}

async function renderDialog(search: string, result: unknown = COMBINED_RESULT, onClose: () => void = () => {}) {
  fetchMocks.fetchCanvassingEvidence.mockResolvedValue(result);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(tree(search, onClose));
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

describe("CanvassingEvidenceDialog — the office scope moving under an open drill", () => {
  // The drill and its links must never describe two different tenants. Nothing in the target or the date
  // range changes when ?officeId does, so without this the dialog kept the previous office's records while
  // every row link had already been rewritten for the new one — and following one lands on whatever
  // unrelated record shares that id there.
  it("closes when ?officeId changes while it is open", async () => {
    const onClose = vi.fn();
    await renderDialog("?officeId=office-atlanta", COMBINED_RESULT, onClose);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      navigate!("/reports/performance/canvassing-activity?officeId=office-dallas");
    });

    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the office scope is dropped entirely", async () => {
    const onClose = vi.fn();
    await renderDialog("?officeId=office-atlanta", COMBINED_RESULT, onClose);

    await act(async () => {
      navigate!("/reports/performance/canvassing-activity");
    });

    expect(onClose).toHaveBeenCalled();
  });

  // The guard must not be so eager that it shuts the dialog on any navigation. ?office is the report's own
  // display filter and does not change tenant, so a drill opened under it stays open.
  it("stays open when a non-tenant query param changes", async () => {
    const onClose = vi.fn();
    await renderDialog("?officeId=office-atlanta", COMBINED_RESULT, onClose);

    await act(async () => {
      navigate!("/reports/performance/canvassing-activity?officeId=office-atlanta&office=dallas");
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  // The regression this ordering exists to prevent: comparing before the fetch effect stamps the office
  // would fire against the initial null and close every dialog on the frame it opened.
  it("does not close itself the moment it opens", async () => {
    const onClose = vi.fn();
    const body = await renderDialog("?officeId=office-atlanta", COMBINED_RESULT, onClose);

    expect(onClose).not.toHaveBeenCalled();
    expect(body.textContent).toContain("Acme Roofing");
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
