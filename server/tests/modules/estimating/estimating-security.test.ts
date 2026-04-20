import { beforeEach, describe, expect, it, vi } from "vitest";

const dealsServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
  getDeals: vi.fn(),
  getDealDetail: vi.fn(),
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  deleteDeal: vi.fn(),
  getDealsForPipeline: vi.fn(),
  getDealSources: vi.fn(),
}));

vi.mock("../../../src/modules/deals/service.js", () => dealsServiceMocks);

const fileServiceMocks = vi.hoisted(() => ({
  confirmUpload: vi.fn(),
}));

vi.mock("../../../src/modules/files/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/files/service.js")>(
    "../../../src/modules/files/service.js"
  );

  return {
    ...actual,
    confirmUpload: fileServiceMocks.confirmUpload,
  };
});

describe("estimating security and recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects document upload when the user cannot access the deal", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(null);
    const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

    const layer = (dealRoutes as any).stack.find(
      (entry: any) => entry.route?.path === "/:id/estimating/documents" && entry.route?.methods?.post
    );
    const handler = layer.route.stack.find((entry: any) => entry.method === "post").handle;

    const req = {
      params: { id: "deal-1" },
      body: { uploadToken: "token-1" },
      tenantDb: {},
      user: {
        id: "user-1",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      commitTransaction: vi.fn(async () => {}),
    } as any;
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    } as any;

    let thrown: any;
    await handler(req, res, (err?: unknown) => {
      thrown = err;
    });

    expect(thrown?.statusCode ?? thrown?.status).toBe(404);
    expect(fileServiceMocks.confirmUpload).not.toHaveBeenCalled();
  });

  it("marks OCR status failed when OCR processing throws", async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));

    const { markEstimateDocumentOcrFailed } = await import(
      "../../../../worker/src/jobs/estimate-document-ocr.js"
    );

    await markEstimateDocumentOcrFailed({ update } as any, "doc-1");

    expect(update).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({ ocrStatus: "failed" });
    expect(updateWhere).toHaveBeenCalled();
  });
});
