import { beforeEach, describe, expect, it, vi } from "vitest";

const eventBusHandlers = vi.hoisted(() => new Map<string, (event: unknown) => Promise<void>>());
const dbExecuteMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    onEvent: vi.fn((eventName: string, handler: (event: unknown) => Promise<void>) => {
      eventBusHandlers.set(eventName, handler);
    }),
  },
}));

vi.mock("../../../src/db.js", () => ({
  db: {
    execute: dbExecuteMock,
  },
  pool: {},
}));

const { registerProcoreEventHandlers } = await import("../../../src/modules/procore/event-handlers.js");

function sqlText(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] })?.queryChunks;
  if (!chunks) return String(value);
  return chunks.map((chunk) => {
    if (typeof chunk === "string") return chunk;
    if (Array.isArray(chunk)) return chunk.join("");
    return JSON.stringify(chunk);
  }).join("");
}

describe("registerProcoreEventHandlers", () => {
  beforeEach(() => {
    eventBusHandlers.clear();
    dbExecuteMock.mockReset();
  });

  it("queues Procore project creation from deal.contract.signed", async () => {
    registerProcoreEventHandlers();
    const handler = eventBusHandlers.get("deal.contract.signed");
    expect(handler).toBeDefined();

    await handler!({
      payload: {
        dealId: "deal-1",
        officeId: "office-1",
      },
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    expect(sqlText(dbExecuteMock.mock.calls[0]?.[0])).toContain("procore_sync");
    expect(sqlText(dbExecuteMock.mock.calls[0]?.[0])).toContain("create_project");
  });

  it("does not queue Procore project creation from deal.won", async () => {
    registerProcoreEventHandlers();
    const handler = eventBusHandlers.get("deal.won");

    if (handler) {
      await handler({
        payload: {
          dealId: "deal-1",
          officeId: "office-1",
        },
      });
    }

    expect(dbExecuteMock).not.toHaveBeenCalled();
  });
});
