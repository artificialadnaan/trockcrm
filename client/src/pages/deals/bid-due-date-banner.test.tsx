// @vitest-environment jsdom

// Pin a non-UTC ambient timezone for this spec. The off-by-one regression these tests guard
// (formatting a UTC-midnight bid date in LOCAL time renders the previous calendar day) is only
// observable when the runner's zone is behind UTC. The CI runner defaults to UTC, where a
// local-time fallback would still pass — so we force America/Chicago (UTC-5/6) here. Node applies
// process.env.TZ at runtime via tzset(); the guard test below fails loudly if it ever doesn't.
process.env.TZ = "America/Chicago";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BidDueDateBanner } from "./bid-due-date-banner";

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

  async function render(bidDueDate: string | null | undefined) {
    await act(async () => {
      root.render(<BidDueDateBanner bidDueDate={bidDueDate} />);
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
});
