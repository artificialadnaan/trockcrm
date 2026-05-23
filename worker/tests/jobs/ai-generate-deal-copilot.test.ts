import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const generateDealCopilotPacketMock = vi.fn();
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

vi.mock("../../src/db.js", () => ({
  pool: {
    connect: connectMock,
  },
}));

vi.mock("../../../server/src/modules/ai-copilot/service.js", () => ({
  generateDealCopilotPacket: generateDealCopilotPacketMock,
}));

vi.mock("../../../server/dist/modules/ai-copilot/service.js", () => ({
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

  it("rejects and logs when requestedBy is missing", async () => {
    const result = await runAiGenerateDealCopilot(
      {
        dealId: "deal-1",
        reason: "manual_regenerate",
      } as any,
      "office-1"
    );

    expect(result).toEqual({
      status: "dead",
      error: "[Worker:ai-generate-deal-copilot] Missing requestedBy for dealId=deal-1",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Worker:ai-generate-deal-copilot] Missing requestedBy for dealId=deal-1"
    );
    expect(connectMock).not.toHaveBeenCalled();
    expect(generateDealCopilotPacketMock).not.toHaveBeenCalled();
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
        requestedByRole: "director",
      },
      "office-1"
    );

    const [, input] = generateDealCopilotPacketMock.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      dealId: "deal-1",
      forceRegenerate: true,
      viewerUserId: "user-7",
    });
    expect(input).not.toHaveProperty("viewerRole");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
