import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const generateDealCopilotPacketMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: {
    connect: connectMock,
  },
}));

vi.mock("../../../server/src/modules/ai-copilot/service.js", () => ({
  generateDealCopilotPacket: generateDealCopilotPacketMock,
}));

const { runAiGenerateDealCopilot } = await import("../../src/jobs/ai-generate-deal-copilot.js");

function createClient(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) {
  return {
    query: vi.fn(queryImpl),
    release: vi.fn(),
  };
}

describe("ai generate deal copilot job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes requestedBy through as viewerUserId", async () => {
    const client = createClient(async (sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("SELECT slug FROM public.offices")) return { rows: [{ slug: "beta" }] };
      if (sql.includes("SELECT set_config")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    });
    connectMock.mockResolvedValue(client);
    generateDealCopilotPacketMock.mockResolvedValue(undefined);

    await runAiGenerateDealCopilot(
      {
        dealId: "deal-1",
        reason: "manual_regenerate",
        requestedBy: "user-7",
      },
      "office-1"
    );

    expect(generateDealCopilotPacketMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dealId: "deal-1",
        forceRegenerate: true,
        viewerUserId: "user-7",
      })
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
