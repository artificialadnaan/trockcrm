// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuditLogPage } from "./audit-log-page";

let auditHookState: any;

vi.mock("@/hooks/use-audit-log", () => ({
  useAuditLog: () => auditHookState,
}));

describe("AuditLogPage", () => {
  it("shows a loading label while the async total is still pending", () => {
    auditHookState = {
      rows: [],
      total: null,
      totalLoading: true,
      totalError: false,
      hasMore: false,
      page: 1,
      setPage: vi.fn(),
      loading: false,
      filter: {},
      setFilter: vi.fn(),
      entityTypes: [],
      loadGroupChildren: vi.fn(),
    };

    const html = ReactDOMServer.renderToStaticMarkup(<AuditLogPage />);

    expect(html).toContain("Loading total...");
  });

  it("shows a failure label when the async total request fails", () => {
    auditHookState = {
      rows: [],
      total: null,
      totalLoading: false,
      totalError: true,
      hasMore: false,
      page: 1,
      setPage: vi.fn(),
      loading: false,
      filter: {},
      setFilter: vi.fn(),
      entityTypes: [],
      loadGroupChildren: vi.fn(),
    };

    const html = ReactDOMServer.renderToStaticMarkup(<AuditLogPage />);

    expect(html).toContain("Total unavailable");
    expect(html).not.toContain("0 entries");
  });

  it("shows the loaded total when the async count succeeds", () => {
    auditHookState = {
      rows: [],
      total: 1000,
      totalLoading: false,
      totalError: false,
      hasMore: false,
      page: 1,
      setPage: vi.fn(),
      loading: false,
      filter: {},
      setFilter: vi.fn(),
      entityTypes: [],
      loadGroupChildren: vi.fn(),
    };

    const html = ReactDOMServer.renderToStaticMarkup(<AuditLogPage />);

    expect(html).toContain("1,000 entries");
  });

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
      totalLoading: false,
      totalError: false,
      hasMore: true,
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
