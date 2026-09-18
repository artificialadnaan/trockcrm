// @vitest-environment jsdom

// Pin a non-UTC ambient timezone for this spec. The off-by-one regression these tests guard
// (formatting a UTC-midnight bid date in LOCAL time renders the previous calendar day) is only
// observable when the runner's zone is behind UTC. The CI runner defaults to UTC, where a
// local-time fallback would still pass — so we force America/Chicago (UTC-5/6) here. Node applies
// process.env.TZ at runtime via tzset(); the guard test below fails loudly if it ever doesn't.
// Capture the prior value and restore it in afterAll so this global mutation doesn't leak into other
// date-sensitive specs that run later in the same Vitest worker.
const previousTZ = process.env.TZ;
process.env.TZ = "America/Chicago";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { BidDueDateBanner, toBidDueDateInputValue } from "./bid-due-date-banner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BidDueDateBanner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  afterAll(() => {
    // Restore the worker's original timezone so this spec doesn't leak America/Chicago into others.
    if (previousTZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTZ;
    }
  });

  // Wrapped in a router because the banner renders a react-router Link. The href itself comes from the
  // CALLER, which is what lets the deal page decide both whether this viewer may edit and how the tenant
  // scope is carried (its own appendOfficeIdSearch) — rather than the banner answering either question.
  async function render(
    bidDueDate: string | null | undefined,
    options: { editHref?: string | null } = {}
  ) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/deals/deal-1"]}>
          <BidDueDateBanner bidDueDate={bidDueDate} editHref={options.editHref} />
        </MemoryRouter>
      );
    });
  }

  it("runs under a non-UTC ambient timezone so the off-by-one assertions are not vacuous", () => {
    // If the TZ pin above failed to take effect (e.g. a UTC runner), UTC midnight Jul 3 stays Jul 3
    // locally and the off-by-one tests below would pass even with a broken local-time formatter. Under
    // America/Chicago, UTC midnight Jul 3 is the evening of Jul 2 — so the local day MUST be "2".
    const localDay = new Date("2026-07-03T00:00:00.000Z").toLocaleDateString("en-US", { day: "numeric" });
    expect(localDay).toBe("2");
  });

  it("renders the UTC-midnight timestamptz on its intended calendar day (no off-by-one)", async () => {
    // deals.bid_due_date is a timestamptz stamped at UTC midnight; the source value was Jul 3, 2026.
    // Formatting in local time (this run uses TZ=America/Chicago, UTC-5/6) would render the PREVIOUS
    // day — Jul 2 — which is exactly the bug this banner must not have. Asserting both the literal
    // "Jul 3, 2026" and the ABSENCE of "Jul 2" makes a local-time regression fail under a non-UTC TZ.
    await render("2026-07-03T00:00:00.000Z");
    const text = container.textContent ?? "";
    expect(text).toContain("Bid due date: Jul 3, 2026");
    expect(text).not.toContain("Jul 2");
  });

  it("renders a date-only 'YYYY-MM-DD' (the lead-backed resolved value) on its intended day", async () => {
    // For lead-backed deals the resolved bid due date is leads.bid_due_date — a `date` column that
    // serializes date-only as "2026-07-03" (no time/zone). new Date("2026-07-03") parses as UTC
    // midnight, so formatting in UTC must still surface Jul 3 (NOT Jul 2) under TZ=America/Chicago.
    await render("2026-07-03");
    const text = container.textContent ?? "";
    expect(text).toContain("Bid due date: Jul 3, 2026");
    expect(text).not.toContain("Jul 2");
  });

  it("renders nothing when bidDueDate is null", async () => {
    await render(null);
    expect(container.textContent).toBe("");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders nothing when bidDueDate is undefined", async () => {
    await render(undefined);
    expect(container.textContent).toBe("");
  });

  it("renders nothing for an invalid date value", async () => {
    await render("not-a-date");
    expect(container.textContent).toBe("");
  });

  // The complaint this answers: the date is shown here and was changeable only from the Scoping tab's
  // Project Overview section, which is not somewhere anyone looks for a bid due date.
  describe("the way to change it", () => {
    it("renders the Change link at the href the caller supplied", async () => {
      await render("2026-07-03T00:00:00.000Z", { editHref: "/deals/deal-9/edit" });
      const link = container.querySelector("a");
      expect(link?.textContent).toBe("Change");
      expect(link?.getAttribute("href")).toBe("/deals/deal-9/edit");
    });

    // The caller owns the tenant scope, so whatever it carries reaches the link verbatim — the banner
    // never builds a second answer to office scoping alongside the page's own appendOfficeIdSearch.
    it("passes an office-scoped href through untouched", async () => {
      await render("2026-07-03T00:00:00.000Z", {
        editHref: "/deals/deal-9/edit?officeId=office-atlanta",
      });
      expect(container.querySelector("a")?.getAttribute("href")).toBe(
        "/deals/deal-9/edit?officeId=office-atlanta"
      );
    });

    // The deal page admits collaborators (estimator / sales-source reps) who cannot edit. Offering
    // them a link would let them complete the form and be refused only on PATCH, losing the change —
    // so the page passes no href and the banner shows none.
    it("shows no link when the caller supplies none, e.g. a viewer who cannot edit", async () => {
      await render("2026-07-03T00:00:00.000Z");
      expect(container.querySelector("a")).toBeNull();
      expect(container.textContent).toContain("Bid due date: Jul 3, 2026");

      await render("2026-07-03T00:00:00.000Z", { editHref: null });
      expect(container.querySelector("a")).toBeNull();
    });
  });
});

// The value the date input is populated from. Same UTC rule as the display formatter, and for the same
// reason: read locally, a UTC-midnight timestamptz lands on the previous day west of UTC, so simply
// opening the form and saving would walk the deadline backwards a day at a time.
describe("toBidDueDateInputValue", () => {
  it("converts a UTC-midnight timestamptz to its intended calendar day", () => {
    expect(toBidDueDateInputValue("2026-07-03T00:00:00.000Z")).toBe("2026-07-03");
  });

  it("passes a date-only lead value through unchanged", () => {
    expect(toBidDueDateInputValue("2026-07-03")).toBe("2026-07-03");
  });

  it("is a round trip — the form re-submits exactly the day it was shown", () => {
    // The regression that matters: input value -> save -> reload -> input value must be stable. Under
    // TZ=America/Chicago a local-time implementation returns 2026-07-02 here and loses a day per save.
    expect(toBidDueDateInputValue("2026-07-03T00:00:00.000Z")).toBe(
      formatToIsoDay(new Date("2026-07-03T00:00:00.000Z"))
    );
  });

  it("treats absent and unparseable values as an empty box, not a crash", () => {
    expect(toBidDueDateInputValue(null)).toBe("");
    expect(toBidDueDateInputValue(undefined)).toBe("");
    expect(toBidDueDateInputValue("")).toBe("");
    expect(toBidDueDateInputValue("not-a-date")).toBe("");
  });
});

function formatToIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
