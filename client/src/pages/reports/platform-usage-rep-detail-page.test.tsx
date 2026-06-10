import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

// Mutable fixture so each test can vary the views state (the name must start with `mock` for the
// hoisted vi.mock factory to reference it).
let mockData: unknown;
vi.mock("@/hooks/use-platform-usage-detail", () => ({
  usePlatformUsageDetail: () => ({ loading: false, error: null, data: mockData }),
}));

import { PlatformUsageRepDetailPage } from "./platform-usage-rep-detail-page";

const base = {
  rep: { id: "r1", displayName: "Kaleb Stone" },
  grain: "week" as const,
  dates: ["2026-06-07", "2026-06-13"],
  actions: {
    breakdown: { create: 3, edit: 12, stage_move: 4, upload: 1, note: 6 },
    items: [
      { type: "stage_move", label: "Tides on Duneville", entityType: "deal", at: "2026-06-09T18:30:00Z" },
      { type: "create", label: "Muir Lake", entityType: "deal", at: "2026-06-08T15:00:00Z" },
    ],
    truncated: false,
  },
};

function render() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/reports/performance/platform-usage/r1?grain=week"]}>
      <PlatformUsageRepDetailPage />
    </MemoryRouter>,
  ).replace(/\s+/g, " ");
}

describe("PlatformUsageRepDetailPage", () => {
  it("renders the rep, the Actions breakdown + itemized actions, and the Views list", () => {
    mockData = {
      ...base,
      views: {
        expired: false,
        items: [
          { at: "2026-06-09T18:31:00Z", entity_type: "deal", entity_id: "d1", route: "/deals/d1", label_snapshot: "Tides on Duneville" },
        ],
      },
    };
    const html = render();
    expect(html).toContain("Kaleb Stone");
    expect(html).toContain("Actions");
    expect(html).toContain("Views");
    expect(html).toContain("Stage move"); // breakdown chip + item badge label
    expect(html).toContain("Tides on Duneville"); // appears as both an action item and a view item
    expect(html).toContain("← Platform Usage"); // back link
  });

  it("renders the explicit 'view detail expired' state for old periods while actions still populate", () => {
    mockData = {
      ...base,
      views: { expired: true, message: "view detail expired for this period — counts only", items: [] },
    };
    const html = render();
    expect(html).toContain("view detail expired for this period — counts only");
    expect(html).toContain("Stage move"); // actions are never pruned, so they still show
    expect(html).not.toContain("/deals/d1"); // no view rows
  });
});
