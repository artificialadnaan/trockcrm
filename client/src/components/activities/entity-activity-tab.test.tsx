// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { EntityActivityTab } from "./entity-activity-tab";

const mocks = vi.hoisted(() => ({
  useActivitiesMock: vi.fn(),
  createActivityMock: vi.fn(),
}));

vi.mock("@/hooks/use-activities", () => ({
  useActivities: mocks.useActivitiesMock,
  createActivity: mocks.createActivityMock,
}));

vi.mock("@/components/activities/activity-log-form", () => ({
  ActivityLogForm: ({ onSubmit }: { onSubmit: (data: {
    type: string;
    subject: string;
    body: string;
    outcome?: string;
    nextStep?: string;
    nextStepDueAt?: string;
    durationMinutes?: number;
    occurredAt?: string;
    responsibleUserId?: string;
  }) => Promise<void> }) => (
    <div>
      <button
        type="button"
        onClick={() => onSubmit({
          type: "note",
          subject: "note logged",
          body: "Company coordination note",
          responsibleUserId: "rep-1",
        })}
      >
        Add Note
      </button>
      <button
        type="button"
        onClick={() => onSubmit({
          type: "email",
          subject: "Manual email",
          body: "Subject: Manual email\nNotes: Sent from phone",
          occurredAt: "2026-05-18T09:15:00.000Z",
        })}
      >
        Log Email
      </button>
      <button
        type="button"
        onClick={() => onSubmit({
          type: "call",
          subject: "call logged",
          body: "Lead follow-up call",
          outcome: "connected",
          nextStep: "Send recap",
          nextStepDueAt: "2026-05-19T15:00:00.000Z",
          durationMinutes: 12,
          responsibleUserId: "rep-2",
        })}
      >
        Log Call
      </button>
    </div>
  ),
}));

vi.mock("@/components/call-recordings/recording-list", () => ({
  RecordingList: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-recording-entity={`${entityType}:${entityId}`}>Recording List</div>
  ),
}));

function mount(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(ui);
  });

  return {
    container,
    unmount() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

describe("EntityActivityTab", () => {
  let mounted: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    mocks.useActivitiesMock.mockReset();
    mocks.createActivityMock.mockReset();

    mocks.useActivitiesMock.mockReturnValue({
      activities: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.createActivityMock.mockResolvedValue({ activity: { id: "activity-1" } });
  });

  it("loads and creates company activities scoped to the company", async () => {
    const refetch = vi.fn();
    mocks.useActivitiesMock.mockReturnValueOnce({
      activities: [],
      loading: false,
      error: null,
      refetch,
    });

    mounted = mount(<EntityActivityTab entityType="company" entityId="company-1" emptyLabel="company" />);

    expect(mocks.useActivitiesMock).toHaveBeenCalledWith({ companyId: "company-1" });
    const addNote = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add Note")
    );

    await act(async () => {
      addNote?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.createActivityMock).toHaveBeenCalledWith({
      type: "note",
      subject: "note logged",
      body: "Company coordination note",
      outcome: undefined,
      durationMinutes: undefined,
      responsibleUserId: "rep-1",
      companyId: "company-1",
    });
    expect(refetch).toHaveBeenCalled();
  });

  it("loads and creates lead activities scoped to the lead", async () => {
    const refetch = vi.fn();
    mocks.useActivitiesMock.mockReturnValueOnce({
      activities: [],
      loading: false,
      error: null,
      refetch,
    });

    mounted = mount(<EntityActivityTab entityType="lead" entityId="lead-1" emptyLabel="lead" />);

    expect(mocks.useActivitiesMock).toHaveBeenCalledWith({ leadId: "lead-1" });
    const logCall = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Log Call")
    );

    await act(async () => {
      logCall?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.createActivityMock).toHaveBeenCalledWith({
      type: "call",
      subject: "call logged",
      body: "Lead follow-up call",
      outcome: "connected",
      nextStep: "Send recap",
      nextStepDueAt: "2026-05-19T15:00:00.000Z",
      durationMinutes: 12,
      responsibleUserId: "rep-2",
      leadId: "lead-1",
    });
    expect(refetch).toHaveBeenCalled();
  });

  it("omits responsibleUserId for deal activities so the server preserves assigned-rep defaulting", async () => {
    const refetch = vi.fn();
    mocks.useActivitiesMock.mockReturnValueOnce({
      activities: [],
      loading: false,
      error: null,
      refetch,
    });

    mounted = mount(<EntityActivityTab entityType="deal" entityId="deal-1" emptyLabel="deal" />);

    expect(mocks.useActivitiesMock).toHaveBeenCalledWith({ dealId: "deal-1" });
    const addNote = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add Note")
    );

    await act(async () => {
      addNote?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.createActivityMock).toHaveBeenCalledWith({
      type: "note",
      subject: "note logged",
      body: "Company coordination note",
      outcome: undefined,
      nextStep: undefined,
      nextStepDueAt: undefined,
      durationMinutes: undefined,
      dealId: "deal-1",
    });
    expect(refetch).toHaveBeenCalled();
  });

  it("creates manually logged email activities scoped to the deal with occurredAt", async () => {
    const refetch = vi.fn();
    mocks.useActivitiesMock.mockReturnValueOnce({
      activities: [],
      loading: false,
      error: null,
      refetch,
    });

    mounted = mount(<EntityActivityTab entityType="deal" entityId="deal-1" emptyLabel="deal" />);

    const logEmail = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Log Email")
    );

    await act(async () => {
      logEmail?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.createActivityMock).toHaveBeenCalledWith({
      type: "email",
      subject: "Manual email",
      body: "Subject: Manual email\nNotes: Sent from phone",
      outcome: undefined,
      nextStep: undefined,
      nextStepDueAt: undefined,
      durationMinutes: undefined,
      occurredAt: "2026-05-18T09:15:00.000Z",
      dealId: "deal-1",
    });
    expect(refetch).toHaveBeenCalled();
  });

  it("keeps activity lists scoped to the selected entity", () => {
    mocks.useActivitiesMock.mockReturnValueOnce({
      activities: [
        {
          id: "activity-company-a",
          type: "note",
          body: "Company A note",
          occurredAt: "2026-05-18T10:00:00.000Z",
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    mounted = mount(<EntityActivityTab entityType="company" entityId="company-a" emptyLabel="company" />);

    expect(mounted.container.textContent).toContain("Company A note");
    expect(mounted.container.textContent).not.toContain("Company B note");
    expect(mocks.useActivitiesMock).toHaveBeenCalledWith({ companyId: "company-a" });
  });
});
