// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { usePendingRfp } from "./use-deals";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

// Mounts the real usePendingRfp hook and exposes a button that switches the office query param within
// the same mounted route (useNavigate, no remount), so a re-fetch must come from the hook's deps.
function Harness() {
  const navigate = useNavigate();
  usePendingRfp();
  return createElement(
    "button",
    { type: "button", onClick: () => navigate("/deals/pending-rfp?officeId=B") },
    "switch office"
  );
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({ deals: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("usePendingRfp", () => {
  it("refetches when the office query param changes within the same mounted route", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/deals/pending-rfp?officeId=A"] },
          createElement(Harness)
        )
      );
    });
    // One fetch on mount.
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith("/deals/pending-rfp");

    // Switch office (only ?officeId changes, no remount) → the URL-driven office context changed, so the
    // queue must refetch rather than keep showing office A.
    await act(async () => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
  });
});
