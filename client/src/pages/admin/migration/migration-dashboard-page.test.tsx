import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { MigrationDashboardPage } from "./migration-dashboard-page";

const mocks = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  useAccessibleOfficesMock: vi.fn(),
  useMigrationSummaryMock: vi.fn(),
  useMigrationExceptionsMock: vi.fn(),
  useOfficeOwnershipQueueMock: vi.fn(),
  previewOwnershipSyncMock: vi.fn(),
  applyOwnershipSyncMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/hooks/use-accessible-offices", () => ({
  useAccessibleOffices: mocks.useAccessibleOfficesMock,
}));

vi.mock("@/hooks/use-migration", () => ({
  useMigrationSummary: mocks.useMigrationSummaryMock,
  useMigrationExceptions: mocks.useMigrationExceptionsMock,
  useOfficeOwnershipQueue: mocks.useOfficeOwnershipQueueMock,
  bulkReassignOwnershipQueueRows: vi.fn(),
}));

vi.mock("@/hooks/use-ownership-cleanup", () => ({
  previewOwnershipSync: mocks.previewOwnershipSyncMock,
  applyOwnershipSync: mocks.applyOwnershipSyncMock,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/admin/ownership-queue-table", () => ({
  OwnershipQueueTable: ({ rows }: { rows: Array<{ recordName: string }> }) => (
    <div data-testid="ownership-queue-table">{rows.map((row) => row.recordName).join(", ")}</div>
  ),
}));

vi.mock("@/components/admin/ownership-reassign-dialog", () => ({
  OwnershipReassignDialog: () => <div data-testid="ownership-reassign-dialog" />,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  };
});

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MigrationDashboardPage />
    </MemoryRouter>
  );
}

describe("MigrationDashboardPage", () => {
  beforeEach(() => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "user-1",
        role: "admin",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
    });

    mocks.useAccessibleOfficesMock.mockReturnValue({
      offices: [
        {
          id: "office-1",
          name: "North Office",
          slug: "north",
        },
        {
          id: "office-2",
          name: "South Office",
          slug: "south",
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
      createOffice: vi.fn(),
      updateOffice: vi.fn(),
    });

    mocks.useMigrationSummaryMock.mockReturnValue({
      summary: {
        deals: {},
        contacts: {},
        activities: {},
        companies: {},
        properties: {},
        leads: {},
        recentRuns: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
      runValidation: vi.fn(),
    });

    mocks.useMigrationExceptionsMock.mockReturnValue({
      exceptions: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    mocks.useOfficeOwnershipQueueMock.mockReturnValue({
      rows: [
        {
          recordType: "deal",
          recordId: "deal-1",
          recordName: "Northstar Expansion",
          stageId: "stage-1",
          stageName: "Qualification",
          officeId: "office-1",
          officeName: "Dallas",
          assignedRepId: null,
          assignedUserName: null,
          reasonCode: "unassigned_owner",
          reasonCodes: ["unassigned_owner", "owner_mapping_failure"],
          severity: "high",
          generatedAt: "2026-04-21T12:00:00.000Z",
          evaluatedAt: "2026-04-21T12:00:00.000Z",
        },
      ],
      byReason: [{ reasonCode: "unassigned_owner", count: 1 }],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.previewOwnershipSyncMock.mockResolvedValue({
      assigned: 3,
      unchanged: 1,
      unmatched: 1,
      conflicts: 0,
      inactiveUserConflicts: 0,
      examples: {
        matched: [],
        unmatched: [],
        conflicts: [],
        inactiveUserConflicts: [],
      },
    });
    mocks.applyOwnershipSyncMock.mockResolvedValue({
      assigned: 3,
      unchanged: 1,
      unmatched: 1,
      conflicts: 0,
      inactiveUserConflicts: 0,
      examples: {
        matched: [],
        unmatched: [],
        conflicts: [],
        inactiveUserConflicts: [],
      },
    });
  });

  it("renders admin ownership sync controls and the office queue", () => {
    const html = renderPage();

    expect(mocks.useOfficeOwnershipQueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ officeId: "office-1" })
    );
    expect(html).toContain("Preview Sync");
    expect(html).toContain("Apply Sync");
    expect(html).toContain("Office Ownership Queue");
    expect(html).toContain("Seed HubSpot owners into CRM assignees");
    expect(html).toContain("Reassign selected");
    expect(html).toContain("Northstar Expansion");
    expect(html).toContain("Office");
    expect(html).toContain("Record type");
    expect(html).toContain("Stage");
    expect(html).toContain("Reason code");
    expect(html).toContain("Stale age");
    expect(html).toContain("North Office");
    expect(html).toContain("All record types");
    expect(html).toContain("All stages");
    expect(html).toContain("All reasons");
    expect(html).toContain("All ages");
  });

  it("renders the director ownership-queue experience without admin-only failures", () => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "user-2",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
    });

    const html = renderPage();

    expect(mocks.useMigrationSummaryMock).toHaveBeenCalledWith(false);
    expect(mocks.useMigrationExceptionsMock).toHaveBeenCalledWith(false);
    expect(html).not.toContain("Preview Sync");
    expect(html).not.toContain("Apply Sync");
    expect(html).not.toContain("Migration Exceptions");
    expect(html).not.toContain("Failed to load migration summary");
    expect(html).not.toContain("Failed to load migration exceptions");
    expect(html).toContain("Refresh Queue");
    expect(html).toContain("North Office");
  });
});
