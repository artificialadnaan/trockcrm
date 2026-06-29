// @vitest-environment jsdom

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
