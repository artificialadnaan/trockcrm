import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";

import {
  buildProjectNumberFirstSetEmail,
  formatCurrency,
  handleProjectNumberFirstSetEmail,
  resolveChristyProjectNumberRecipient,
  resolveFrontendUrl,
  resolveProjectNumberEmailCcRecipient,
} from "../../../../worker/src/jobs/project-number-email.js";
import { sendSystemEmailWithMetadata } from "../../../../worker/src/lib/system-email.js";

const migrationSql = fs.readFileSync(
  new URL("../../../../migrations/0138_project_number_first_set_notification.sql", import.meta.url),
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

  it("never falls back to a hardcoded dev address when NODE_ENV is unset or non-canonical (prod-safety)", () => {
    // The fallback is an allowlist of {development, test}, NOT `!== production`, so a misconfigured
    // prod worker (NODE_ENV unset / "prod" / "staging") returns null and fails loudly instead of
    // silently emailing the hardcoded dev recipient.
    expect(resolveChristyProjectNumberRecipient({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveChristyProjectNumberRecipient({ NODE_ENV: "" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveChristyProjectNumberRecipient({ NODE_ENV: "staging" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveChristyProjectNumberRecipient({ NODE_ENV: "prod" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveProjectNumberEmailCcRecipient({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveProjectNumberEmailCcRecipient({ NODE_ENV: "staging" } as NodeJS.ProcessEnv)).toBeNull();
    // an explicitly-configured value always wins, regardless of NODE_ENV
    expect(resolveChristyProjectNumberRecipient({
      CHRISTY_PROJECT_NUMBER_EMAIL: "christy@example.com",
    } as NodeJS.ProcessEnv)).toBe("christy@example.com");
    expect(resolveProjectNumberEmailCcRecipient({
      PROJECT_NUMBER_EMAIL_CC: "adnaan@example.com",
    } as NodeJS.ProcessEnv)).toBe("adnaan@example.com");
    // the development context still gets the dev convenience default
    expect(resolveChristyProjectNumberRecipient({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe("kscheidegger@trockgc.com");
  });

  it("builds an email with the required fields, the canonical deal link (no officeId), and the branded logo/button", () => {
    const email = buildProjectNumberFirstSetEmail({
      dealId: "deal-1",
      dealName: "The Noble Property",
      projectNumber: "DFW-1-12345-aa",
      salesRepName: "Avery Rep",
      awardedAmount: "123456.78",
      frontendUrl: "https://crm.example.com/",
    });

    expect(email.subject).toBe("New project number assigned: DFW-1-12345-aa (The Noble Property)");
    expect(email.html).toContain("The Noble Property");
    expect(email.html).toContain("DFW-1-12345-aa");
    expect(email.html).toContain("Avery Rep");
    expect(email.html).toContain("$123,456.78");
    // canonical deal URL: /deals/{id} with NO query string (officeId dropped)
    expect(email.dealUrl).toBe("https://crm.example.com/deals/deal-1");
    expect(email.html).toContain("https://crm.example.com/deals/deal-1");
    expect(email.html).not.toContain("officeId");
    // branded building blocks: hosted PNG logo + the View-Deal button carry the link
    expect(email.html).toContain('<img src="https://trockcrm.com/trock-logo-email.png"');
    expect(email.html).toContain('alt="T Rock Construction"');
    expect(email.html).toContain("View Deal in CRM");
    expect(email.text).toContain("Awarded amount: $123,456.78");
    expect(email.text).toContain("https://crm.example.com/deals/deal-1");
  });

  it("link domain regression: the production default points at trockcrm.com, never trockconstruction.com", () => {
    // worker leaves FRONTEND_URL unset, so this default is what every link renders.
    expect(resolveFrontendUrl({} as NodeJS.ProcessEnv)).toBe("https://trockcrm.com");
    const email = buildProjectNumberFirstSetEmail({
      dealId: "acbf7a59-c774-4d35-a9db-40296de8e03e",
      dealName: "Sample",
      projectNumber: "DFW-1-99999-zz",
      salesRepName: "Rep",
      awardedAmount: null,
      frontendUrl: resolveFrontendUrl({} as NodeJS.ProcessEnv),
    });
    expect(email.dealUrl).toBe("https://trockcrm.com/deals/acbf7a59-c774-4d35-a9db-40296de8e03e");
    expect(email.html).toContain("https://trockcrm.com/deals/acbf7a59-c774-4d35-a9db-40296de8e03e");
    // the broken domain must never reappear anywhere in the email
    expect(email.html).not.toContain("trockconstruction.com");
    expect(email.dealUrl).not.toContain("trockconstruction.com");
    expect(email.text).not.toContain("trockconstruction.com");
  });

  it("is Outlook-safe: table layout, inline CSS only, hosted PNG logo with width/height, VML button, no web-only constructs", () => {
    const email = buildProjectNumberFirstSetEmail({
      dealId: "d",
      dealName: "n",
      projectNumber: "p",
      salesRepName: "r",
      awardedAmount: null,
      frontendUrl: "https://trockcrm.com",
    });
    const h = email.html;
    expect(h).toContain('role="presentation"'); // table-based layout
    expect(h).toContain("<v:roundrect"); // VML bulletproof button (Outlook)
    expect(h).toContain("PixelsPerInch"); // mso image-scaling fix
    expect(h).toContain('width="220" height="246"'); // logo sized via HTML attributes, not CSS
    expect(h).not.toMatch(/<style[\s>]/i); // Outlook ignores <style> blocks — everything inline
    expect(h).not.toMatch(/<link[\s>]/i); // no external CSS
    expect(h).not.toMatch(/display:\s*(flex|grid)/i); // no flexbox/grid
    expect(h).not.toMatch(/\.svg|<svg/i); // no SVG (filename or inline element)
    expect(h).not.toMatch(/background-image/i); // no CSS background-images for critical content
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
    // missing required recipient must be a VISIBLE failure (error, not warn) before the job retries
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("CHRISTY_PROJECT_NUMBER_EMAIL is not set"),
      expect.objectContaining({ projectNumber: "DFW-1-12345-aa" })
    );
    expect(logger.warn).not.toHaveBeenCalled();
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
      });
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
      .mockResolvedValueOnce({ rows: [] }) // call 1: receipt-check (none yet)
      .mockResolvedValueOnce({ rows: [dealRow] }) // call 2: deal-load
      .mockResolvedValueOnce({ rows: [] }) // call 3: receipt-insert (after send)
      .mockResolvedValueOnce({ rows: [{ resend_message_id: "resend-1", sent_at: new Date().toISOString() }] }); // call 4: 2nd-call receipt-check (already sent)
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
      expect.stringContaining("https://crm.example.com/deals/00000000-0000-0000-0000-000000000001"),
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
      .mockResolvedValueOnce({ rows: [] }) // T1 call 1: receipt-check
      .mockResolvedValueOnce({ rows: [dealRow] }) // T1 call 2: deal-load
      .mockResolvedValueOnce({ rows: [] }) // T1 call 3: receipt-insert
      .mockResolvedValueOnce({ rows: [] }) // T2 call 4: receipt-check
      .mockResolvedValueOnce({ rows: [dealRow] }) // T2 call 5: deal-load
      .mockResolvedValueOnce({ rows: [] }); // T2 call 6: receipt-insert
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
      4,
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
    // dropping the CC must be a VISIBLE failure (error, not warn); Christy's email still sends
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("PROJECT_NUMBER_EMAIL_CC is not set"),
      expect.objectContaining({ projectNumber: "DFW-1-12345-aa" })
    );
    expect(logger.warn).not.toHaveBeenCalled();
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
