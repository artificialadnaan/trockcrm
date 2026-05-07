import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {},
}));

const getMyCleanupQueueMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/modules/admin/cleanup-queue-service.js", () => ({
  getMyCleanupQueue: getMyCleanupQueueMock,
}));

vi.mock("../../../src/modules/migration/service.js", () => ({
  getMigrationSummary: vi.fn(),
}));

describe("dashboard dateOnly formatter", () => {
  it("formats Date objects and ISO strings as yyyy-mm-dd", async () => {
    const { dateOnly } = await import("../../../src/modules/dashboard/service.js");

    expect(dateOnly(new Date("2026-05-07T00:00:00.000Z"))).toBe("2026-05-07");
    expect(dateOnly("2026-05-07T00:00:00Z")).toBe("2026-05-07");
    expect(dateOnly(null)).toBe("");
    expect(dateOnly(undefined)).toBe("");
  });
});
