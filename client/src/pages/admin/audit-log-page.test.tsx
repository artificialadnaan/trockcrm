// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuditLogPage } from "./audit-log-page";

let auditHookState: any;

vi.mock("@/hooks/use-audit-log", () => ({
  useAuditLog: () => auditHookState,
}));

describe("AuditLogPage", () => {
  it("renders grouped batch audit rows without exploding them into child entries", () => {
    auditHookState = {
      rows: [
        {
          type: "group",
          id: "batch:bid-board-sync",
          processName: "Bid Board Sync",
          startTime: "2026-05-15T16:03:00.000Z",
          endTime: "2026-05-15T16:03:52.000Z",
          totalCount: 352,
          distinctEntityCount: 176,
          entityType: "deal",
          action: "update",
          previewEntities: [],
          childEntries: [],
        },
      ],
      total: 352,
      page: 1,
      setPage: vi.fn(),
      loading: false,
      filter: {},
      setFilter: vi.fn(),
      entityTypes: ["deal"],
      loadGroupChildren: vi.fn(),
    };

    const html = ReactDOMServer.renderToStaticMarkup(<AuditLogPage />);

    expect(html).toContain("Bid Board Sync");
    expect(html).toContain("352 deals updated");
    expect(html).toContain("Expand");
    expect(html).not.toContain("System updated deals:");
  });
});
