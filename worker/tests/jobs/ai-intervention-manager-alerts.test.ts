import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const runManagerAlertPreviewMock = vi.fn();
const sendManagerAlertSummaryMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: {
    connect: async () => ({
      query: queryMock,
      release: vi.fn(),
    }),
  },
  db: {},
}));

vi.mock("../../../server/src/modules/ai-copilot/intervention-manager-alerts-service.js", () => ({
  runManagerAlertPreview: runManagerAlertPreviewMock,
  sendManagerAlertSummary: sendManagerAlertSummaryMock,
}));

const { runAiInterventionManagerAlerts } = await import("../../src/jobs/ai-intervention-manager-alerts.js");

function makeAlertSnapshot(overrides?: Partial<Record<"overdueHighCritical" | "snoozeBreached" | "escalatedOpen" | "assigneeOverload", number>>) {
  return {
    version: 1,
    officeId: "office-beta",
    timezone: "America/Chicago",
    officeLocalDate: "2026-04-16",
    generatedAt: "2026-04-16T13:00:00.000Z",
    link: "/admin/intervention-analytics",
    families: {
      overdueHighCritical: { count: overrides?.overdueHighCritical ?? 0, queueLink: "/admin/interventions?view=overdue", caseIds: [] },
      snoozeBreached: { count: overrides?.snoozeBreached ?? 0, queueLink: "/admin/interventions?view=snooze-breached", caseIds: [] },
      escalatedOpen: { count: overrides?.escalatedOpen ?? 0, queueLink: "/admin/interventions?view=escalated", caseIds: [] },
      assigneeOverload: {
        count: overrides?.assigneeOverload ?? 0,
        threshold: 15,
        queueLink: null,
        items: [],
      },
    },
  };
}

describe("ai intervention manager alerts worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
    runManagerAlertPreviewMock.mockReset();
    sendManagerAlertSummaryMock.mockReset();
  });

  it("sends manager alerts for due offices at 8:00 AM local time and skips missing schemas", async () => {
    const sentRecipients: string[] = [];
    const previewCalls: string[] = [];
    const skippedSchemas: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return {
          rows: [
            { id: "office-beta", slug: "beta", timezone: "America/Chicago" },
            { id: "office-empty", slug: "empty", timezone: "America/Chicago" },
            { id: "office-dfw", slug: "dfw", timezone: "America/Chicago" },
            { id: "office-west", slug: "west", timezone: "America/Los_Angeles" },
          ],
        };
      }

      if (sql.includes("FROM information_schema.schemata")) {
        const schemaName = String(params?.[0] ?? "");
        if (schemaName === "office_dfw") {
          skippedSchemas.push(schemaName);
          return { rows: [] };
        }
        return { rows: [{ schema_name: schemaName }] };
      }

      if (sql.includes("SELECT pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }

      if (sql.includes("FROM public.users") && sql.includes("role IN ('admin', 'director')")) {
        const officeId = String(params?.[0] ?? "");
        if (officeId === "office-beta") {
          return { rows: [{ id: "director-1" }, { id: "admin-1" }] };
        }
        if (officeId === "office-empty") {
          return { rows: [{ id: "director-2" }] };
        }
        return { rows: [] };
      }

      if (sql.includes("SELECT pg_advisory_unlock")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    runManagerAlertPreviewMock.mockImplementation(async (_db: unknown, input: { officeId: string }) => {
      previewCalls.push(input.officeId);
      if (input.officeId === "office-beta") {
        return { snapshotJson: makeAlertSnapshot({ overdueHighCritical: 2, snoozeBreached: 1 }) };
      }
      if (input.officeId === "office-empty") {
        return { snapshotJson: makeAlertSnapshot() };
      }
      throw new Error(`Unexpected preview office: ${input.officeId}`);
    });

    sendManagerAlertSummaryMock.mockImplementation(async (_db: unknown, input: { officeId: string; recipientUserId: string }) => {
      sentRecipients.push(`${input.officeId}:${input.recipientUserId}`);
      return {
        claimed: input.recipientUserId === "director-1",
        snapshot: { snapshotJson: makeAlertSnapshot({ overdueHighCritical: 2, snoozeBreached: 1 }) },
        notification: { id: `notification-${input.recipientUserId}` },
      };
    });

    await runAiInterventionManagerAlerts({ now: new Date("2026-04-16T13:00:00.000Z") });

    expect(previewCalls).toEqual(["office-beta", "office-empty"]);
    expect(sendManagerAlertSummaryMock).toHaveBeenCalledTimes(2);
    expect(sentRecipients).toEqual(["office-beta:director-1", "office-beta:admin-1"]);
    expect(skippedSchemas).toEqual(["office_dfw"]);
    expect(
      logSpy.mock.calls.some(([message]) =>
        typeof message === "string" &&
        message.includes("Sent manager alerts for office beta: 1 delivered, 1 suppressed")
      )
    ).toBe(true);

    logSpy.mockRestore();
  });

  it("does not send alerts for offices outside the 8 AM office-local window or for empty snapshots", async () => {
    const previewCalls: string[] = [];
    const sentRecipients: string[] = [];

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return {
          rows: [
            { id: "office-west", slug: "west", timezone: "America/Los_Angeles" },
            { id: "office-empty", slug: "empty", timezone: "America/Chicago" },
          ],
        };
      }

      if (sql.includes("FROM information_schema.schemata")) {
        return { rows: [{ schema_name: String(params?.[0] ?? "") }] };
      }

      if (sql.includes("SELECT pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }

      if (sql.includes("FROM public.users") && sql.includes("role IN ('admin', 'director')")) {
        return { rows: [{ id: "director-1" }] };
      }

      if (sql.includes("SELECT pg_advisory_unlock")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    runManagerAlertPreviewMock.mockImplementation(async (_db: unknown, input: { officeId: string }) => {
      previewCalls.push(input.officeId);
      return { snapshotJson: makeAlertSnapshot() };
    });

    sendManagerAlertSummaryMock.mockImplementation(async (_db: unknown, input: { officeId: string; recipientUserId: string }) => {
      sentRecipients.push(`${input.officeId}:${input.recipientUserId}`);
      return {
        claimed: true,
        snapshot: { snapshotJson: makeAlertSnapshot() },
        notification: { id: `notification-${input.recipientUserId}` },
      };
    });

    await runAiInterventionManagerAlerts({ now: new Date("2026-04-16T13:00:00.000Z") });

    expect(previewCalls).toEqual(["office-empty"]);
    expect(sendManagerAlertSummaryMock).not.toHaveBeenCalled();
    expect(sentRecipients).toEqual([]);
  });

  it("explicitly skips weekend local days even when the hour matches 8 AM", async () => {
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return {
          rows: [
            { id: "office-beta", slug: "beta", timezone: "America/Chicago" },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    await runAiInterventionManagerAlerts({ now: new Date("2026-04-18T13:00:00.000Z") });

    expect(runManagerAlertPreviewMock).not.toHaveBeenCalled();
    expect(sendManagerAlertSummaryMock).not.toHaveBeenCalled();
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("FROM information_schema.schemata"))
    ).toBe(false);
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("FROM public.users"))
    ).toBe(false);
  });
});
