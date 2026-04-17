import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const hookState = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  reset() {
    this.values = [];
    this.index = 0;
  },
  rewind() {
    this.index = 0;
  },
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

    return {
      ...actual,
      useState: (initialValue: unknown) => {
      const index = hookState.index++;
      if (hookState.values[index] === undefined) {
        hookState.values[index] = initialValue;
      }

      const setState = (value: unknown) => {
        hookState.values[index] =
          typeof value === "function"
            ? (value as (previous: unknown) => unknown)(hookState.values[index])
            : value;
      };

      return [hookState.values[index], setState] as const;
      },
      useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
      useRef: (initialValue: unknown) => ({ current: initialValue }),
      useEffect: (effect: () => void | Promise<void>) => {
        void effect();
      },
  };
});

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

const {
  runManagerAlertScan,
  sendManagerAlertSummary,
  useManagerAlertSnapshot,
} = await import("./use-ai-ops");

function buildSnapshot(mode: "preview" | "sent" = "preview") {
  return {
    id: "snapshot-1",
    officeId: "office-1",
    snapshotKind: "manager_alert_summary",
    snapshotMode: mode,
    snapshotJson: {
      version: 1,
      officeId: "office-1",
      timezone: "America/Chicago",
      officeLocalDate: "2026-04-16",
      generatedAt: "2026-04-16T13:00:00.000Z",
      link: "/admin/intervention-analytics",
      families: {
        overdueHighCritical: {
          count: 2,
          queueLink: "/admin/interventions?view=overdue",
          caseIds: ["case-1", "case-2"],
        },
        snoozeBreached: {
          count: 1,
          queueLink: "/admin/interventions?view=snooze-breached",
          caseIds: ["case-3"],
        },
        escalatedOpen: {
          count: 1,
          queueLink: "/admin/interventions?view=escalated",
          caseIds: ["case-4"],
        },
        assigneeOverload: {
          count: 1,
          threshold: 15,
          queueLink: "/admin/interventions?view=all",
          items: [
            {
              assigneeId: "manager-1",
              assigneeLabel: "Manager One",
              totalWeight: 18,
              caseCount: 4,
              queueLink: "/admin/interventions?view=all&assigneeId=manager-1",
            },
          ],
        },
      },
    },
    scannedAt: "2026-04-16T13:00:00.000Z",
    sentAt: mode === "sent" ? "2026-04-16T13:00:00.000Z" : null,
    createdAt: "2026-04-16T13:00:00.000Z",
    updatedAt: "2026-04-16T13:00:00.000Z",
  };
}

describe("useManagerAlertSnapshot", () => {
  beforeEach(() => {
    apiMock.mockReset();
    hookState.reset();
  });

  it("fetches the latest manager alert snapshot", async () => {
    apiMock.mockResolvedValueOnce(buildSnapshot());

    hookState.rewind();
    const initial = useManagerAlertSnapshot();
    expect(initial.loading).toBe(true);

    await Promise.resolve();

    hookState.rewind();
    const result = useManagerAlertSnapshot();

    expect(result.data?.snapshotJson.officeLocalDate).toBe("2026-04-16");
    expect(apiMock).toHaveBeenCalledWith("/ai/ops/intervention-manager-alerts");
  });

  it("treats a missing snapshot as an empty state", async () => {
    apiMock.mockRejectedValueOnce(new Error("Manager alert snapshot not found"));

    hookState.rewind();
    const initial = useManagerAlertSnapshot();
    expect(initial.loading).toBe(true);

    await Promise.resolve();

    hookState.rewind();
    const result = useManagerAlertSnapshot();

    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });
});

describe("manager alert actions", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("posts the preview scan route", async () => {
    const snapshot = buildSnapshot("preview");
    apiMock.mockResolvedValueOnce(snapshot);

    await expect(runManagerAlertScan()).resolves.toEqual(snapshot);
    expect(apiMock).toHaveBeenCalledWith("/ai/ops/intervention-manager-alerts/scan", {
      method: "POST",
      json: {},
    });
  });

  it("posts the send route and returns the sent snapshot", async () => {
    const snapshot = buildSnapshot("sent");
    apiMock.mockResolvedValueOnce({ snapshot, deliveries: [{ recipientUserId: "user-1", claimed: true, notification: null }] });

    await expect(sendManagerAlertSummary()).resolves.toEqual({
      snapshot,
      deliveries: [{ recipientUserId: "user-1", claimed: true, notification: null }],
    });
    expect(apiMock).toHaveBeenCalledWith("/ai/ops/intervention-manager-alerts/send", {
      method: "POST",
      json: {},
    });
  });
});
