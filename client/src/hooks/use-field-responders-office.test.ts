// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The whole cross-office fix hinges on useFieldResponders re-loading when opts.officeId changes (the api() layer
// forwards ?officeId as the x-office-id header; the hook must actually re-fire so the new office's roster loads
// and the prior office's rows don't linger). Hand-rolled renderHook via createRoot + act, matching the repo
// convention in use-debounced-value.test.ts (no @testing-library — not a dependency).

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  api: apiMock,
  isApiError: () => false,
}));

const { useFieldResponders } = await import("./use-field-responders");

async function renderRoster(initialOfficeId: string | null) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const state: { officeId: string | null } = { officeId: initialOfficeId };

  function Probe() {
    useFieldResponders({ officeId: state.officeId });
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
  });

  return {
    async setOffice(officeId: string | null) {
      state.officeId = officeId;
      await act(async () => {
        root.render(createElement(Probe));
      });
    },
    unmount() {
      root.unmount();
    },
  };
}

describe("useFieldResponders office scope", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({ responders: [] });
  });

  it("refetches when officeId changes so a cross-office switch reloads the roster", async () => {
    const hook = await renderRoster("office-a");
    expect(apiMock).toHaveBeenCalledTimes(1);

    await hook.setOffice("office-b");
    expect(apiMock).toHaveBeenCalledTimes(2); // the office switch re-ran the load

    hook.unmount();
  });

  it("does not refetch on a re-render when officeId is unchanged (no refetch storm)", async () => {
    const hook = await renderRoster("office-a");
    expect(apiMock).toHaveBeenCalledTimes(1);

    await hook.setOffice("office-a"); // same office -> stable refetch identity -> no new load
    expect(apiMock).toHaveBeenCalledTimes(1);

    hook.unmount();
  });
});
