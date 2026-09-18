// A job the server writes and the worker never registers is a row that sits in `job_queue` forever with
// nothing failing to say so — no error, no dead letter, just an email that never arrives. This pins the
// registration, and pins that the string the server enqueues under is the string the worker listens on.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MARKETING_EXPENSE_EMAIL_JOB } from "@trock-crm/shared/types";

const handlers = new Map<string, (payload: any, officeId: string | null) => Promise<unknown>>();
const handleMarketingExpenseEmailMock = vi.fn();

vi.mock("../../src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/queue.js")>();
  return {
    ...actual,
    registerJobHandler: vi.fn((jobType: string, handler: any) => {
      handlers.set(jobType, handler);
    }),
  };
});

vi.mock("../../src/jobs/marketing-expense-email.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/jobs/marketing-expense-email.js")>();
  return { ...actual, handleMarketingExpenseEmail: handleMarketingExpenseEmailMock };
});

const { registerAllJobs } = await import("../../src/jobs/index.js");

describe("marketing expense email job registration", () => {
  beforeEach(() => {
    handlers.clear();
    handleMarketingExpenseEmailMock.mockReset();
    registerAllJobs();
  });

  it("registers a handler under the job type the server enqueues", () => {
    expect(MARKETING_EXPENSE_EMAIL_JOB).toBe("marketing_expense_email");
    expect(handlers.get(MARKETING_EXPENSE_EMAIL_JOB)).toBeDefined();
  });

  it("routes the payload through to the handler", async () => {
    const payload = { tenantSchema: "office_dallas", requestId: "req-1" };
    await handlers.get(MARKETING_EXPENSE_EMAIL_JOB)?.(payload, "office-uuid");
    expect(handleMarketingExpenseEmailMock).toHaveBeenCalledWith(payload, "office-uuid");
  });
});
