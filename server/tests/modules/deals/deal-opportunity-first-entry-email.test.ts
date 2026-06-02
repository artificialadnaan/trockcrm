import { describe, expect, it, vi } from "vitest";

import {
  DEAL_OPPORTUNITY_FIRST_ENTRY_JOB,
  handleDealOpportunityFirstEntryEmail,
} from "../../../../worker/src/jobs/project-number-email.js";

/**
 * Worker-handler tests for the re-keyed notification. The deal_number (not project_number) is the
 * operative number, the receipts ledger and Resend idempotencyKey are dedicated to this event, and —
 * critically — two jobs that share an audit_log_id (a re-entry into Opportunity, which the trigger
 * re-enqueues with the SAME stable marker id) collapse to exactly ONE send via the receipts check.
 */

describe("deal opportunity first-entry notification email (worker handler)", () => {
  it("exposes the new job type constant", () => {
    expect(DEAL_OPPORTUNITY_FIRST_ENTRY_JOB).toBe("deal_opportunity_first_entry_email");
  });

  it("retries instead of completing when CHRISTY_PROJECT_NUMBER_EMAIL is unset in production", async () => {
    const sendEmail = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      handleDealOpportunityFirstEntryEmail(
        {
          tenantSchema: "office_dallas",
          dealId: "00000000-0000-0000-0000-000000000001",
          dealNumber: "DFW-4-15326-ab",
          auditLogId: 123,
        },
        null,
        { env: { NODE_ENV: "production" } as NodeJS.ProcessEnv, query: vi.fn(), sendEmail, logger },
      ),
    ).rejects.toThrow("CHRISTY_PROJECT_NUMBER_EMAIL is not configured");

    expect(sendEmail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("CHRISTY_PROJECT_NUMBER_EMAIL is not set"),
      expect.objectContaining({ dealNumber: "DFW-4-15326-ab" }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sends with the deal_number as the operative number and a dedicated idempotencyKey; retries on delivery failure", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // receipt check
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-0000-0000-000000000001",
          name: "Noble",
          deal_number: "DFW-4-15326-ab",
          awarded_amount: "50",
          sales_rep_name: "Avery Rep",
        }],
      });
    const sendEmail = vi.fn().mockResolvedValue({ success: false, messageId: null });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      handleDealOpportunityFirstEntryEmail(
        {
          tenantSchema: "office_dallas",
          dealId: "00000000-0000-0000-0000-000000000001",
          dealNumber: "DFW-4-15326-ab",
          auditLogId: 123,
        },
        null,
        {
          env: {
            NODE_ENV: "production",
            CHRISTY_PROJECT_NUMBER_EMAIL: "christy@example.com",
            PROJECT_NUMBER_EMAIL_CC: "adnaan@example.com",
            FRONTEND_URL: "https://crm.example.com",
          } as NodeJS.ProcessEnv,
          query,
          sendEmail,
          logger,
        },
      ),
    ).rejects.toThrow("Email provider returned unsuccessful result");

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM "office_dallas".deals'), [
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(sendEmail).toHaveBeenCalledWith(
      "christy@example.com",
      "New project number assigned: DFW-4-15326-ab (Noble)",
      expect.stringContaining("Avery Rep"),
      {
        text: expect.stringContaining("Awarded amount: $50.00"),
        idempotencyKey: "deal-opportunity-first-entry-office_dallas-123",
        cc: "adnaan@example.com",
      },
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[OpportunityEntryEmail] Failed to send Christy notification",
      expect.objectContaining({ dealNumber: "DFW-4-15326-ab" }),
    );
  });

  it("records a receipt and dedups a re-entry job that shares the same audit_log_id (exactly-once)", async () => {
    const dealId = "00000000-0000-0000-0000-000000000001";
    const dealRow = {
      id: dealId,
      name: "Noble",
      deal_number: "DFW-4-15326-ab",
      awarded_amount: "50",
      sales_rep_name: "Avery Rep",
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // call 1: receipt check (none yet)
      .mockResolvedValueOnce({ rows: [dealRow] }) // call 1: deal load
      .mockResolvedValueOnce({ rows: [] }) // call 1: receipt insert
      .mockResolvedValueOnce({ rows: [{ resend_message_id: "resend-1", sent_at: new Date().toISOString() }] }); // call 2: receipt check (already sent)
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-1" });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const payload = {
      tenantSchema: "office_dallas",
      dealId,
      dealNumber: "DFW-4-15326-ab",
      auditLogId: 123,
    };
    const deps = {
      env: {
        NODE_ENV: "production",
        CHRISTY_PROJECT_NUMBER_EMAIL: "christy@example.com",
        PROJECT_NUMBER_EMAIL_CC: "adnaan@example.com",
        FRONTEND_URL: "https://crm.example.com",
      } as NodeJS.ProcessEnv,
      query,
      sendEmail,
      logger,
    };

    await handleDealOpportunityFirstEntryEmail(payload, null, deps); // first entry -> sends
    await handleDealOpportunityFirstEntryEmail(payload, null, deps); // re-entry (same id) -> dedup

    expect(sendEmail).toHaveBeenCalledTimes(1);
    // the dedup hinges on the receipts CHECK querying the right ledger by (tenant_schema, audit_log_id)
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM public.deal_opportunity_first_entry_email_receipts"),
      ["office_dallas", 123],
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("FROM public.deal_opportunity_first_entry_email_receipts"),
      ["office_dallas", 123],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO public.deal_opportunity_first_entry_email_receipts"),
      [123, "office_dallas", dealId, "DFW-4-15326-ab", "christy@example.com", "resend-1"],
    );
    expect(logger.log).toHaveBeenCalledWith(
      "[OpportunityEntryEmail] Notification already sent - skipping duplicate job",
      expect.objectContaining({ auditLogId: 123 }),
    );
  });

  it("sends to Christy without CC when PROJECT_NUMBER_EMAIL_CC is unset in production", async () => {
    const dealId = "00000000-0000-0000-0000-000000000001";
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: dealId, name: "Noble", deal_number: "DFW-4-15326-ab", awarded_amount: "50", sales_rep_name: "Avery Rep" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-1" });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleDealOpportunityFirstEntryEmail(
      { tenantSchema: "office_dallas", dealId, dealNumber: "DFW-4-15326-ab", auditLogId: 123 },
      null,
      {
        env: {
          NODE_ENV: "production",
          CHRISTY_PROJECT_NUMBER_EMAIL: "christy@example.com",
          FRONTEND_URL: "https://crm.example.com",
        } as NodeJS.ProcessEnv,
        query,
        sendEmail,
        logger,
      },
    );

    expect(sendEmail).toHaveBeenCalledWith(
      "christy@example.com",
      "New project number assigned: DFW-4-15326-ab (Noble)",
      expect.any(String),
      {
        text: expect.stringContaining("Awarded amount: $50.00"),
        idempotencyKey: "deal-opportunity-first-entry-office_dallas-123",
      },
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("PROJECT_NUMBER_EMAIL_CC is not set"),
      expect.objectContaining({ dealNumber: "DFW-4-15326-ab" }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
