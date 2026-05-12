// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { useOfficeOwnershipQueue, type OwnershipQueueFilters } from "./use-migration";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);

function Probe({ filters }: { filters: OwnershipQueueFilters }) {
  useOfficeOwnershipQueue(filters);
  return null;
}

async function flushEffects() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useOfficeOwnershipQueue", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.clearAllMocks();
  });

  async function renderProbe(filters: OwnershipQueueFilters) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<Probe filters={filters} />);
      await flushEffects();
    });
  }

  it("does not call cleanup office API until officeId is resolved", async () => {
    await renderProbe({});

    expect(apiMock).not.toHaveBeenCalled();
  });

  it("passes officeId in query params and office header when available", async () => {
    apiMock.mockResolvedValueOnce({ rows: [], byReason: [] });

    await renderProbe({ officeId: "office-1" });

    expect(apiMock).toHaveBeenCalledWith(
      "/admin/cleanup/office?officeId=office-1",
      expect.objectContaining({
        headers: { "x-office-id": "office-1" },
      })
    );
  });
});
