// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { PlatformUsageRow } from "@/hooks/use-platform-usage-report";
import { useTableSort, type UseTableSortOptions, type UseTableSortResult } from "@/components/reports/sortable";

// The page module imports the usage hook (which pulls the api client) at module load; stub it so we
// can import the real PLATFORM_USAGE_SORT_COLUMNS without side effects.
vi.mock("@/hooks/use-platform-usage-report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-platform-usage-report")>();
  return { ...actual, usePlatformUsageReport: () => ({ loading: false, error: null, data: null }) };
});

import { PLATFORM_USAGE_SORT_COLUMNS } from "./platform-usage-page";

// Real PlatformUsageRow rows. Zane has no session → Views renders "—" (viewsAreEmpty).
const ROWS: PlatformUsageRow[] = [
  { rep: { id: "r1", displayName: "Kaleb" }, usage: { activeSeconds: 51600, actionCount: 312, sessionCount: 5, viewCount: 9, breakdown: { activities: {} } } },
  { rep: { id: "r2", displayName: "Adnaan" }, usage: { activeSeconds: 32700, actionCount: 188, sessionCount: 4, viewCount: 4, breakdown: { activities: {} } } },
  { rep: { id: "r3", displayName: "Zane" }, usage: { activeSeconds: 0, actionCount: 0, sessionCount: 0, viewCount: 0, breakdown: { activities: {} } } },
];

async function renderHook(options?: UseTableSortOptions) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let api: UseTableSortResult<PlatformUsageRow>;
  function Probe() {
    api = useTableSort(ROWS, PLATFORM_USAGE_SORT_COLUMNS, options);
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    get current() {
      return api;
    },
    async act(fn: () => void) {
      await act(async () => {
        fn();
      });
    },
  };
}

describe("Platform Usage leaderboard sort columns", () => {
  it("sorts by rep name alphabetically, independent of the actions ranking", async () => {
    const hook = await renderHook();
    await hook.act(() => hook.current.toggle("rep"));
    expect(hook.current.sortedRows.map((r) => r.rep.displayName)).toEqual(["Adnaan", "Kaleb", "Zane"]);
  });

  it("sorts by actions numerically (desc by default), not lexically", async () => {
    const hook = await renderHook({ initialSort: { key: "actions", dir: "desc" } });
    expect(hook.current.sortedRows.map((r) => r.usage.actionCount)).toEqual([312, 188, 0]);
  });

  it("sorts blank view counts (no session) last in both directions", async () => {
    const lastName = (api: UseTableSortResult<PlatformUsageRow>) => {
      const names = api.sortedRows.map((r) => r.rep.displayName);
      return names[names.length - 1];
    };
    const hook = await renderHook();
    await hook.act(() => hook.current.toggle("views")); // numeric → desc first
    expect(lastName(hook.current)).toBe("Zane");
    await hook.act(() => hook.current.toggle("views")); // asc
    expect(lastName(hook.current)).toBe("Zane");
  });
});
