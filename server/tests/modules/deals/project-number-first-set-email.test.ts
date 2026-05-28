import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  buildProjectNumberFirstSetEmail,
  formatCurrency,
  handleProjectNumberFirstSetEmail,
  resolveChristyProjectNumberRecipient,
  resolveProjectNumberEmailCcRecipient,
} from "../../../../worker/src/jobs/project-number-email.js";
import { sendSystemEmailWithMetadata } from "../../../../worker/src/lib/system-email.js";

const migrationSql = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/0138_project_number_first_set_notification.sql"),
  "utf8"
);

describe("project number first-set notification migration", () => {
  it("installs a tenant trigger that fires only on blank-to-set project_number changes", () => {
    expect(migrationSql).toContain("AFTER INSERT OR UPDATE OF project_number");
    expect(migrationSql).toContain("NULLIF(BTRIM(NEW.project_number), '')");
    expect(migrationSql).toContain("NULLIF(BTRIM(OLD.project_number), '')");
    expect(migrationSql).toContain("old_project_number IS NOT NULL");
  });

  it("uses audit_log as the idempotency source and enqueues one worker email job", () => {
    expect(migrationSql).toContain("audit_log_project_number_first_set_uidx");
    expect(migrationSql).toContain("actor_system_process = 'project_number_first_set'");
    expect(migrationSql).toContain("ON CONFLICT DO NOTHING");
    expect(migrationSql).toContain("'project_number_first_set_email'");
    expect(migrationSql).toContain("'tenantSchema', TG_TABLE_SCHEMA");
    expect(migrationSql).toContain("jsonb_build_array(jsonb_build_object");
    expect(migrationSql).toContain("'key', 'projectNumber'");
    expect(migrationSql).toContain("jsonb_build_object('projectNumber', jsonb_build_object('from', NULL, 'to', $4))");
    expect(migrationSql).not.toContain("Failed to enqueue project_number_first_set_email");
    expect(migrationSql).not.toContain("EXCEPTION WHEN OTHERS");
  });

  it("seeds first-set audit markers for existing project-numbered deals before enabling the trigger", () => {
    expect(migrationSql).toContain("INSERT INTO %I.audit_log");
    expect(migrationSql).toContain("FROM %I.deals d");
    expect(migrationSql).toContain("WHERE NULLIF(BTRIM(d.project_number), '') IS NOT NULL");
    expect(migrationSql).toContain("'transition', 'existing'");
    expect(migrationSql).toContain("ON CONFLICT DO NOTHING");

    const seedIndex = migrationSql.indexOf("'transition', 'existing'");
    const triggerIndex = migrationSql.indexOf("CREATE TRIGGER deals_project_number_first_set_email_trg");
    expect(seedIndex).toBeGreaterThan(-1);
    expect(triggerIndex).toBeGreaterThan(-1);
    expect(seedIndex).toBeLessThan(triggerIndex);
  });

  it("creates a sent-email receipt table for worker retry idempotency", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.project_number_first_set_email_receipts");
    expect(migrationSql).toContain("audit_log_id bigint NOT NULL");
    expect(migrationSql).not.toContain("audit_log_id bigint PRIMARY KEY");
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS project_number_first_set_email_receipts_pkey");
    expect(migrationSql).toContain("PRIMARY KEY (tenant_schema, audit_log_id)");
    expect(migrationSql).toContain("resend_message_id text");
  });

  it("supports the bulk-script skip setting before enqueueing email", () => {
    expect(migrationSql).toContain("app.skip_project_number_email");
    expect(migrationSql).toContain("('1', 'true', 'yes', 'on')");
  });

  it("includes tenant provisioning DDL for future office schemas", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("ON office_dallas.audit_log (record_id)");
    expect(migrationSql).toContain("ON office_dallas.deals");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
  });
});

describe("project number first-set notification email", () => {
  it("resolves the configured recipient and defaults only outside production", () => {
    expect(resolveChristyProjectNumberRecipient({
      CHRISTY_PROJECT_NUMBER_EMAIL: " christy@example.com ",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv)).toBe("christy@example.com");
    expect(resolveChristyProjectNumberRecipient({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("kscheidegger@trockgc.com");
    expect(resolveChristyProjectNumberRecipient({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("resolves the configured CC and defaults only outside production", () => {
    expect(resolveProjectNumberEmailCcRecipient({
      PROJECT_NUMBER_EMAIL_CC: " adnaan@example.com ",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv)).toBe("adnaan@example.com");
    expect(resolveProjectNumberEmailCcRecipient({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("adnaan.iqbal@gmail.com");
    expect(resolveProjectNumberEmailCcRecipient({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("builds an email with the required fields and awarded_amount currency", () => {
    const email = buildProjectNumberFirstSetEmail({
      dealId: "deal-1",
      dealName: "The Noble Property",
      projectNumber: "DFW-1-12345-aa",
      salesRepName: "Avery Rep",
      awardedAmount: "123456.78",
      officeId: "office-dallas",
      frontendUrl: "https://crm.example.com/",
    });

    expect(email.subject).toBe("New project number assigned: DFW-1-12345-aa (The Noble Property)");
    expect(email.html).toContain("The Noble Property");
    expect(email.html).toContain("DFW-1-12345-aa");
    expect(email.html).toContain("Avery Rep");
    expect(email.html).toContain("$123,456.78");
    expect(email.html).toContain("https://crm.example.com/deals/deal-1?officeId=office-dallas");
    expect(email.text).toContain("Awarded amount: $123,456.78");
  });

  it("formats missing or invalid awarded_amount as not set", () => {
    expect(formatCurrency(null)).toBe("Not set");
    expect(formatCurrency("not-a-number")).toBe("Not set");
  });

  it("retries instead of completing the job when CHRISTY_PROJECT_NUMBER_EMAIL is unset in production", async () => {
    const sendEmail = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(handleProjectNumberFirstSetEmail(
      {
        tenantSchema: "office_dallas",
        dealId: "00000000-0000-0000-0000-000000000001",
        projectNumber: "DFW-1-12345-aa",
        auditLogId: 123,
      },
      null,
      {
        env: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
        query: vi.fn(),
        sendEmail,
        logger,
      }
    )).rejects.toThrow("CHRISTY_PROJECT_NUMBER_EMAIL is not configured");

    expect(sendEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[ProjectNumberEmail] CHRISTY_PROJECT_NUMBER_EMAIL is not configured - retrying later",
      expect.objectContaining({ projectNumber: "DFW-1-12345-aa" })
    );
  });

  it("sends using loaded deal data and retries when email delivery fails", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-0000-0000-000000000001",
          name: "Noble",
          project_number: "DFW-1-12345-aa",
          deal_number: "HS-1",
          awarded_amount: "50",
          sales_rep_name: "Avery Rep",
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "office-dallas" }] });
    const sendEmail = vi.fn().mockResolvedValue({ success: false, messageId: null });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(handleProjectNumberFirstSetEmail(
      {
        tenantSchema: "office_dallas",
        dealId: "00000000-0000-0000-0000-000000000001",
        projectNumber: "DFW-1-12345-aa",
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
      }
    )).rejects.toThrow("Email provider returned unsuccessful result");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM \"office_dallas\".deals"), [
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(sendEmail).toHaveBeenCalledWith(
      "christy@example.com",
      "New project number assigned: DFW-1-12345-aa (Noble)",
      expect.stringContaining("Avery Rep"),
      {
        text: expect.stringContaining("Awarded amount: $50.00"),
        idempotencyKey: "project-number-first-set-office_dallas-123",
        cc: "adnaan@example.com",
      }
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[ProjectNumberEmail] Failed to send Christy notification",
      expect.objectContaining({ projectNumber: "DFW-1-12345-aa" })
    );
  });

  it("records a sent receipt and skips a duplicate job for the same audit row", async () => {
    const dealId = "00000000-0000-0000-0000-000000000001";
    const dealRow = {
      id: dealId,
      name: "Noble",
      project_number: "DFW-1-12345-aa",
      deal_number: "HS-1",
      awarded_amount: "50",
      sales_rep_name: "Avery Rep",
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [dealRow] })
      .mockResolvedValueOnce({ rows: [{ id: "office-dallas" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ resend_message_id: "resend-1", sent_at: new Date().toISOString() }] });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-1" });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const payload = {
      tenantSchema: "office_dallas",
      dealId,
      projectNumber: "DFW-1-12345-aa",
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

    await handleProjectNumberFirstSetEmail(payload, null, deps);
    await handleProjectNumberFirstSetEmail(payload, null, deps);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      "christy@example.com",
      "New project number assigned: DFW-1-12345-aa (Noble)",
      expect.stringContaining("https://crm.example.com/deals/00000000-0000-0000-0000-000000000001?officeId=office-dallas"),
      expect.objectContaining({ idempotencyKey: "project-number-first-set-office_dallas-123" })
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO public.project_number_first_set_email_receipts"), [
      123,
      "office_dallas",
      dealId,
      "DFW-1-12345-aa",
      "christy@example.com",
      "resend-1",
    ]);
    expect(logger.log).toHaveBeenCalledWith(
      "[ProjectNumberEmail] Notification already sent - skipping duplicate job",
      expect.objectContaining({ auditLogId: 123 })
    );
  });

  it("does not collapse different tenants that share the same audit log id", async () => {
    const dealId = "00000000-0000-0000-0000-000000000001";
    const dealRow = {
      id: dealId,
      name: "Noble",
      project_number: "DFW-1-12345-aa",
      deal_number: "HS-1",
      awarded_amount: "50",
      sales_rep_name: "Avery Rep",
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [dealRow] })
      .mockResolvedValueOnce({ rows: [{ id: "office-dallas" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [dealRow] })
      .mockResolvedValueOnce({ rows: [{ id: "office-atlanta" }] })
      .mockResolvedValueOnce({ rows: [] });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-1" });
    const deps = {
      env: {
        NODE_ENV: "production",
        CHRISTY_PROJECT_NUMBER_EMAIL: "christy@example.com",
        PROJECT_NUMBER_EMAIL_CC: "adnaan@example.com",
        FRONTEND_URL: "https://crm.example.com",
      } as NodeJS.ProcessEnv,
      query,
      sendEmail,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    await handleProjectNumberFirstSetEmail(
      { tenantSchema: "office_dallas", dealId, projectNumber: "DFW-1-12345-aa", auditLogId: 123 },
      null,
      deps
    );
    await handleProjectNumberFirstSetEmail(
      { tenantSchema: "office_atlanta", dealId, projectNumber: "DFW-1-12345-aa", auditLogId: 123 },
      null,
      deps
    );

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      idempotencyKey: "project-number-first-set-office_dallas-123",
    }));
    expect(sendEmail.mock.calls[1]?.[3]).toEqual(expect.objectContaining({
      idempotencyKey: "project-number-first-set-office_atlanta-123",
    }));
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE tenant_schema = $1"),
      ["office_dallas", 123]
    );
    expect(query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("WHERE tenant_schema = $1"),
      ["office_atlanta", 123]
    );
    const receiptInsertCalls = query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO public.project_number_first_set_email_receipts")
    );
    expect(receiptInsertCalls).toHaveLength(2);
    expect(receiptInsertCalls[0]?.[1]).toEqual([
      123,
      "office_dallas",
      dealId,
      "DFW-1-12345-aa",
      "christy@example.com",
      "resend-1",
    ]);
    expect(receiptInsertCalls[1]?.[1]).toEqual([
      123,
      "office_atlanta",
      dealId,
      "DFW-1-12345-aa",
      "christy@example.com",
      "resend-1",
    ]);
  });

  it("sends to Christy without CC when PROJECT_NUMBER_EMAIL_CC is unset in production", async () => {
    const dealId = "00000000-0000-0000-0000-000000000001";
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: dealId,
          name: "Noble",
          project_number: "DFW-1-12345-aa",
          deal_number: "HS-1",
          awarded_amount: "50",
          sales_rep_name: "Avery Rep",
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "office-dallas" }] })
      .mockResolvedValueOnce({ rows: [] });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-1" });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleProjectNumberFirstSetEmail(
      {
        tenantSchema: "office_dallas",
        dealId,
        projectNumber: "DFW-1-12345-aa",
        auditLogId: 123,
      },
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
      }
    );

    expect(sendEmail).toHaveBeenCalledWith(
      "christy@example.com",
      "New project number assigned: DFW-1-12345-aa (Noble)",
      expect.any(String),
      {
        text: expect.stringContaining("Awarded amount: $50.00"),
        idempotencyKey: "project-number-first-set-office_dallas-123",
      }
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[ProjectNumberEmail] PROJECT_NUMBER_EMAIL_CC is not configured - sending without CC",
      expect.objectContaining({ projectNumber: "DFW-1-12345-aa" })
    );
  });

  it("does not mark production email successful when Resend is not configured", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalApiKey = process.env.RESEND_API_KEY;
    const originalOverride = process.env.EMAIL_OVERRIDE_RECIPIENT;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.NODE_ENV = "production";
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_OVERRIDE_RECIPIENT;

      await expect(sendSystemEmailWithMetadata(
        "christy@example.com",
        "Subject",
        "<p>Body</p>"
      )).resolves.toEqual({ success: false, messageId: null });
      expect(errorSpy).toHaveBeenCalledWith("[Email] RESEND_API_KEY is not configured in production");
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = originalApiKey;
      if (originalOverride === undefined) delete process.env.EMAIL_OVERRIDE_RECIPIENT;
      else process.env.EMAIL_OVERRIDE_RECIPIENT = originalOverride;
      errorSpy.mockRestore();
    }
  });
});
