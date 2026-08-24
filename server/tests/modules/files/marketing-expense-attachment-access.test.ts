// Reading an expense-request attachment has to be gated on the REQUEST, at the moment it is read.
//
// THE HOLE THIS PINS. `files` authorizes per association: a deal-linked file goes through the deal check, a
// lead-linked one through the lead check, and anything else is treated as office-shared. An expense-request
// attachment fell into "anything else" — so any same-office CRM user holding an attachment UUID could read
// its metadata and be handed a presigned download URL for a request that `getMarketingExpenseRequest`
// explicitly refuses them. Attachments on this form are quotes, contracts and pricing.
//
// Every chain is covered, not just the download: metadata, download, audit log, versions, and the two
// mutation paths. A guard added to one branch of a five-branch `else if` ladder is the shape of bug that
// gets called fixed.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const currentUser = {
  id: "rep-1",
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

const assertMarketingExpenseRequestReadAccess = vi.fn(async () => undefined);
const assertMarketingExpenseAttachmentAccess = vi.fn(async () => undefined);

vi.mock("../../../src/modules/marketing-expense/service.js", () => ({
  assertMarketingExpenseRequestReadAccess,
  assertMarketingExpenseAttachmentAccess,
}));

const ATTACHMENT = {
  id: "file-1",
  dealId: null,
  leadId: null,
  contactId: null,
  marketingExpenseRequestId: "req-1",
  uploadedBy: "someone-else",
  category: "proposal",
  mimeType: "application/pdf",
  externalUrl: null,
  r2Key: "office_dallas/marketing-expense-requests/req-1/proposals/quote.pdf",
  deletedAt: null,
};

const getFileById = vi.fn(async () => ATTACHMENT);
const getFileByIdIncludingDeleted = vi.fn(async () => ATTACHMENT);
const getFileVersions = vi.fn(async () => []);
const getFileDownloadUrl = vi.fn(async () => ({ url: "https://r2.example/get", expiresIn: 900 }));

vi.mock("../../../src/modules/files/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/files/service.js")>();
  return {
    ...actual,
    getFileById,
    getFileByIdIncludingDeleted,
    getFileVersions,
    getFileDownloadUrl,
    shouldServeExternalFileUrl: () => false,
    updateFile: vi.fn(async () => ATTACHMENT),
    updateFileAddress: vi.fn(async () => ATTACHMENT),
  };
});

const { createApp } = await import("../../../src/app.js");

// A REAL AppError. The express error handler branches on `instanceof AppError`, so a plain Error with a
// statusCode bolted on renders as a 500 and the test would be asserting the wrong thing entirely.
const REFUSAL = new AppError(403, "You do not have access to this expense request.");

beforeEach(() => {
  currentUser.role = "rep";
  assertMarketingExpenseRequestReadAccess.mockReset();
  assertMarketingExpenseRequestReadAccess.mockResolvedValue(undefined);
  assertMarketingExpenseAttachmentAccess.mockReset();
  assertMarketingExpenseAttachmentAccess.mockResolvedValue(undefined);
  // Cleared too, or "was the presigner reached?" carries over from the previous case and the
  // not-called assertion below is answering a question about a different request.
  getFileDownloadUrl.mockClear();
  getFileById.mockClear();
});

const READ_ROUTES: Array<[string, string]> = [
  ["metadata", "/api/files/file-1"],
  ["download", "/api/files/file-1/download"],
  ["audit log", "/api/files/file-1/audit-log"],
  ["versions", "/api/files/file-1/versions"],
];

describe("reading an expense-request attachment", () => {
  it.each(READ_ROUTES)("gates the %s route on the parent request", async (_label, path) => {
    await request(createApp()).get(path);
    expect(assertMarketingExpenseRequestReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      "req-1",
      expect.objectContaining({ id: "rep-1", role: "rep" }),
    );
  });

  it.each(READ_ROUTES)("refuses the %s route when the request denies the caller", async (_label, path) => {
    assertMarketingExpenseRequestReadAccess.mockRejectedValue(REFUSAL);
    const response = await request(createApp()).get(path);
    expect(response.status).toBe(403);
  });

  it("does NOT hand out a presigned URL when the request denies the caller", async () => {
    assertMarketingExpenseRequestReadAccess.mockRejectedValue(REFUSAL);
    const response = await request(createApp()).get("/api/files/file-1/download");
    expect(response.status).toBe(403);
    expect(getFileDownloadUrl).not.toHaveBeenCalled();
  });

  it("uses the READ rule, not the attachment-write rule — an approver may read a decided request", async () => {
    // The write guard is submitter-only and closes on decision. Reading is submitter OR approver, and stays
    // open afterwards; wiring the write guard into the read paths would lock approvers out of the evidence
    // they approved.
    await request(createApp()).get("/api/files/file-1");
    expect(assertMarketingExpenseAttachmentAccess).not.toHaveBeenCalled();
  });
});

describe("mutating an expense-request attachment", () => {
  it("gates PATCH /:id on the attachment-write rule", async () => {
    await request(createApp()).patch("/api/files/file-1").send({ description: "renamed" });
    expect(assertMarketingExpenseAttachmentAccess).toHaveBeenCalledWith(
      expect.anything(),
      "req-1",
      "rep-1",
    );
  });

  it("refuses PATCH /:id once the request has been decided", async () => {
    assertMarketingExpenseAttachmentAccess.mockRejectedValue(
      new AppError(409, "This request has already been decided — its attachments are final."),
    );
    const response = await request(createApp()).patch("/api/files/file-1").send({ description: "x" });
    expect(response.status).toBe(409);
  });

  // DELETION is a write that depends on request status, so the invariant covers it: an admin could
  // otherwise soft-delete a supporting document after the request was approved, and `loadDetail` selects
  // only active files, so it would vanish from the record of what the approver saw. `requireAdmin` limits
  // WHO can do it; it says nothing about WHEN.
  it("gates DELETE /:id on the attachment-write rule", async () => {
    currentUser.role = "admin";
    await request(createApp()).delete("/api/files/file-1");
    expect(assertMarketingExpenseAttachmentAccess).toHaveBeenCalledWith(
      expect.anything(),
      "req-1",
      "rep-1",
    );
  });

  it("refuses DELETE /:id once the request has been decided", async () => {
    currentUser.role = "admin";
    assertMarketingExpenseAttachmentAccess.mockRejectedValue(
      new AppError(409, "This request has already been decided — its attachments are final."),
    );
    const response = await request(createApp()).delete("/api/files/file-1");
    expect(response.status).toBe(409);
  });

  it("gates PATCH /:id/address on the attachment-write rule too", async () => {
    await request(createApp())
      .patch("/api/files/file-1/address")
      .send({ latitude: 1, longitude: 2, address: "somewhere" });
    expect(assertMarketingExpenseAttachmentAccess).toHaveBeenCalledWith(
      expect.anything(),
      "req-1",
      "rep-1",
    );
  });
});

describe("files with no expense request", () => {
  it("is left entirely alone", async () => {
    getFileById.mockResolvedValueOnce({ ...ATTACHMENT, marketingExpenseRequestId: null } as never);
    await request(createApp()).get("/api/files/file-1");
    expect(assertMarketingExpenseRequestReadAccess).not.toHaveBeenCalled();
    expect(assertMarketingExpenseAttachmentAccess).not.toHaveBeenCalled();
  });
});
