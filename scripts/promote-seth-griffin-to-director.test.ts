import { describe, expect, it, vi } from "vitest";
import {
  buildAuditInsertSql,
  buildPromoteUserSql,
  buildPromotionPlan,
  parsePromoteSethArgs,
  runPromoteSethGriffin,
  tenantSchemaForOfficeSlug,
  type OperatorRow,
  type QueryableClient,
  type TargetUserRow,
} from "./promote-seth-griffin-to-director.js";

const SETH_ID = "00000000-0000-4000-8000-000000000242";
const OPERATOR_ID = "00000000-0000-4000-8000-000000000243";

function target(overrides: Partial<TargetUserRow> = {}): TargetUserRow {
  return {
    id: SETH_ID,
    email: "sgriffin@trockgc.com",
    display_name: "Seth Griffin",
    role: "field_contractor",
    is_active: false,
    token_version: 7,
    office_id: "00000000-0000-4000-8000-000000000244",
    office_slug: "dallas",
    local_auth_present: true,
    local_auth_enabled: true,
    local_auth_must_change_password: false,
    local_auth_revoked_at: null,
    local_auth_locked_until: null,
    local_auth_invite_expires_at: null,
    local_auth_last_login_at: null,
    ...overrides,
  };
}

function operator(overrides: Partial<OperatorRow> = {}): OperatorRow {
  return {
    id: OPERATOR_ID,
    email: "admin@trockgc.com",
    display_name: "Admin User",
    role: "admin",
    is_active: true,
    ...overrides,
  };
}

function makeClient(input: { target?: TargetUserRow; operator?: OperatorRow; officeAccess?: Array<{ office_slug: string; role_override: string | null }> } = {}) {
  let currentTarget = input.target ?? target();
  const currentOperator = input.operator ?? operator();
  const calls: string[] = [];
  const auditRows: unknown[][] = [];

  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push(text.trim());
    if (text.includes("FROM public.users u")) return { rows: [{ ...currentTarget }] };
    if (text.includes("FROM public.users") && text.includes("display_name")) return { rows: [{ ...currentOperator }] };
    if (text.includes("FROM public.user_office_access")) return { rows: input.officeAccess ?? [] };
    if (text.includes("to_regclass")) return { rows: [{ relation: "office_dallas.audit_log" }] };
    if (text.includes("UPDATE public.users")) {
      currentTarget = {
        ...currentTarget,
        role: "director",
        is_active: true,
        token_version: currentTarget.token_version + 1,
      };
      return {
        rows: [{
          id: currentTarget.id,
          role: currentTarget.role,
          is_active: currentTarget.is_active,
          token_version: currentTarget.token_version,
        }],
      };
    }
    if (text.includes(".audit_log")) {
      auditRows.push(values ?? []);
      return { rows: [] };
    }
    return { rows: [] };
  });

  return { client: { query } as unknown as QueryableClient, query, calls, auditRows, getTarget: () => currentTarget };
}

describe("promote-seth-griffin-to-director safety contract", () => {
  it("requires an explicit mode, audited operator, and absolute backup directory", () => {
    expect(() => parsePromoteSethArgs([])).toThrow(/exactly one/i);
    expect(() => parsePromoteSethArgs(["--dry-run"])).toThrow(/operator-email/i);
    expect(() => parsePromoteSethArgs(["--dry-run", "--commit", "--operator-email=admin@trockgc.com"])).toThrow(/exactly one/i);
    expect(() => parsePromoteSethArgs(["--dry-run", "--operator-email=admin@trockgc.com", "--backup-dir=relative"])).toThrow(/absolute/i);
    expect(parsePromoteSethArgs(["--dry-run", "--operator-email=ADMIN@trockgc.com"])).toMatchObject({
      mode: "dry-run",
      operatorEmail: "admin@trockgc.com",
    });
  });

  it("pins the narrow SQL contract: same user row, director + active + token bump, no password write", () => {
    const sql = buildPromoteUserSql();
    expect(sql).toContain("UPDATE public.users");
    expect(sql).toContain("'director'::user_role");
    expect(sql).toContain("is_active = true");
    expect(sql).toContain("token_version = token_version + 1");
    expect(sql).toContain("role = 'field_contractor'::user_role");
    expect(sql).not.toContain("user_local_auth");
    expect(sql).not.toContain("password");
  });

  it("keeps disabled, revoked, or expired-unused local auth outside the promotion and tells the operator to use Send Invite", () => {
    const currentTime = new Date("2026-08-27T12:00:00.000Z");
    const plan = buildPromotionPlan(target({ local_auth_revoked_at: "2026-08-27T00:00:00.000Z" }), operator(), [], currentTime);
    expect(plan.action).toBe("promote");
    expect(plan.loginReadiness).toBe("send_invite_required");

    const expiredInvitePlan = buildPromotionPlan(target({
      local_auth_invite_expires_at: "2026-08-27T11:59:59.000Z",
      local_auth_last_login_at: null,
    }), operator(), [], currentTime);
    expect(expiredInvitePlan.loginReadiness).toBe("send_invite_required");
  });

  it("reports a current local-auth lock without clearing it", () => {
    const plan = buildPromotionPlan(target({
      local_auth_locked_until: "2026-08-27T12:15:00.000Z",
    }), operator(), [], new Date("2026-08-27T12:00:00.000Z"));
    expect(plan.loginReadiness).toBe("temporarily_locked");
  });

  it("uses a validated tenant schema in a parameterized audit record", () => {
    expect(tenantSchemaForOfficeSlug("Dallas")).toBe("office_dallas");
    expect(() => tenantSchemaForOfficeSlug("dallas; drop schema public")).toThrow(/invalid office slug/i);
    const sql = buildAuditInsertSql("office_dallas");
    expect(sql).toContain('INSERT INTO "office_dallas".audit_log');
    expect(sql).toContain("'update'::public.audit_action");
    expect(sql).toContain("$1::uuid");
    expect(sql).toContain("$2::uuid");
  });

  it("dry run has zero transaction/write calls", async () => {
    const { client, calls } = makeClient();
    const result = await runPromoteSethGriffin({
      client,
      argv: ["--dry-run", "--operator-email=admin@trockgc.com"],
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result.committed).toBe(false);
    expect(calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)$/i.test(call))).toBe(false);
    expect(calls.some((call) => call.includes("UPDATE public.users") || call.includes(".audit_log"))).toBe(false);
  });

  it("commits the exact role correction only after snapshot + audit preflight, preserving the user identity", async () => {
    const { client, calls, auditRows, getTarget } = makeClient();
    const events: string[] = [];
    const result = await runPromoteSethGriffin({
      client,
      argv: ["--commit", "--operator-email=admin@trockgc.com", "--backup-dir=/private/tmp"],
      logger: { log: vi.fn(), warn: vi.fn() },
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      writeSnapshot: async (filePath, contents) => {
        events.push(`snapshot:${filePath}`);
        expect(contents).toContain("field_contractor");
      },
    });

    expect(result.committed).toBe(true);
    expect(result.snapshotPath).toContain("/private/tmp/promote-seth-griffin-to-director-");
    expect(getTarget()).toMatchObject({ id: SETH_ID, role: "director", is_active: true, token_version: 8 });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.[0]).toBe(SETH_ID);
    expect(auditRows[0]?.[1]).toBe(OPERATOR_ID);
    expect(events[0]).toContain("snapshot:");
    expect(calls.findIndex((call) => call.includes("UPDATE public.users"))).toBeGreaterThan(
      calls.findIndex((call) => call.includes("to_regclass")),
    );
    expect(calls[calls.length - 1]).toBe("COMMIT");
  });

  it("fails closed on an unexpected existing CRM role before it opens a write transaction", async () => {
    const { client, calls } = makeClient({ target: target({ role: "rep", is_active: true }) });
    await expect(runPromoteSethGriffin({
      client,
      argv: ["--commit", "--operator-email=admin@trockgc.com"],
      logger: { log: vi.fn(), warn: vi.fn() },
    })).rejects.toThrow(/unexpected Seth role/i);
    expect(calls).not.toContain("BEGIN");
  });
});
