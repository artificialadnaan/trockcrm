// The upload route has to ASK before it presigns.
//
// `assertMarketingExpenseAttachmentAccess` has its own suite next door, but nothing proved the route calls
// it — and an unwired guard is the same as no guard: any CRM user could have posted somebody else's request
// id and had a file filed against it. (This test did not exist until a mutation that deleted the call from
// files/routes.ts killed nothing.)
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const currentUser = {
  id: "user-1",
  email: "rep@example.com",
  displayName: "Reggie Rep",
  role: "rep",
  officeId: "office-1",
  activeOfficeId: "office-1",
};

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: (req: any, _res: any, next: () => void) => {
    req.user = { ...currentUser };
    next();
  },
}));

vi.mock("../../../src/middleware/tenant.js", () => ({
  tenantMiddleware: (req: any, _res: any, next: () => void) => {
    req.tenantDb = {};
    req.officeSlug = "dallas";
    req.commitTransaction = async () => undefined;
    next();
  },
}));

const assertMarketingExpenseAttachmentAccess = vi.fn(async () => undefined);
const requestUploadUrl = vi.fn(async () => ({ uploadUrl: "https://r2.example/put", uploadToken: "tok" }));

vi.mock("../../../src/modules/marketing-expense/service.js", () => ({
  assertMarketingExpenseAttachmentAccess,
}));

vi.mock("../../../src/modules/files/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/files/service.js")>();
  return { ...actual, requestUploadUrl };
});

const { createApp } = await import("../../../src/app.js");

const BODY = {
  originalFilename: "quote.pdf",
  mimeType: "application/pdf",
  fileSizeBytes: 4096,
  category: "proposal",
};

beforeEach(() => {
  assertMarketingExpenseAttachmentAccess.mockClear();
  assertMarketingExpenseAttachmentAccess.mockResolvedValue(undefined);
  requestUploadUrl.mockClear();
});

describe("POST /api/files/upload-url with a marketing expense request", () => {
  it("asks the expense-request guard BEFORE handing out a presigned URL", async () => {
    const response = await request(createApp())
      .post("/api/files/upload-url")
      .send({ ...BODY, marketingExpenseRequestId: "req-1" });

    expect(response.status).toBe(200);
    // The SESSION user's id. The guard takes an id rather than a role-bearing user: it has no approver
    // branch, and a `role` it never reads would invite a caller to think otherwise.
    expect(assertMarketingExpenseAttachmentAccess).toHaveBeenCalledWith(
      expect.anything(),
      "req-1",
      "user-1",
    );
    expect(
      assertMarketingExpenseAttachmentAccess.mock.invocationCallOrder[0],
    ).toBeLessThan(requestUploadUrl.mock.invocationCallOrder[0]!);
  });

  it("does not presign at all when the guard refuses", async () => {
    assertMarketingExpenseAttachmentAccess.mockRejectedValue(
      new AppError(403, "You can only attach files to your own expense request."),
    );
    const response = await request(createApp())
      .post("/api/files/upload-url")
      .send({ ...BODY, marketingExpenseRequestId: "someone-elses" });

    expect(response.status).toBe(403);
    expect(requestUploadUrl).not.toHaveBeenCalled();
  });

  it("threads the request id through to the service, so the file row is actually associated", async () => {
    await request(createApp())
      .post("/api/files/upload-url")
      .send({ ...BODY, marketingExpenseRequestId: "req-1" });

    expect(requestUploadUrl).toHaveBeenCalledWith(
      expect.anything(),
      "dallas",
      "user-1",
      expect.objectContaining({ marketingExpenseRequestId: "req-1" }),
    );
  });

  it("leaves an ordinary deal upload alone", async () => {
    await request(createApp())
      .post("/api/files/upload-url")
      .send({ ...BODY, dealId: undefined });
    expect(assertMarketingExpenseAttachmentAccess).not.toHaveBeenCalled();
  });
});
