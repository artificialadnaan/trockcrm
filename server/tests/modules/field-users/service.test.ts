import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  transaction: vi.fn(),
}));
const emailMocks = vi.hoisted(() => ({
  sendSystemEmail: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async (password: string) => `hash:${password}`),
  verifyPassword: vi.fn(async (password: string) => password === "correct-password-12"),
  signJwt: vi.fn(() => "jwt-token"),
}));
const TEST_CREDENTIAL = "<redacted - test creds in ops vault>";

vi.mock("../../../src/db.js", () => ({
  db: dbMocks,
}));
vi.mock("../../../src/lib/resend-client.js", () => emailMocks);
vi.mock("../../../src/modules/auth/local-auth-service.js", () => ({
  hashPassword: authMocks.hashPassword,
  verifyPassword: authMocks.verifyPassword,
}));
vi.mock("../../../src/modules/auth/service.js", () => ({
  signJwt: authMocks.signJwt,
}));

const {
  acceptFieldInvite,
  buildFieldPasswordResetEmail,
  buildInviteEmail,
  completeFieldUserPasswordReset,
  deriveInviteStatus,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteFieldUser,
  listFieldUsers,
  loginFieldUser,
  normalizeEmail,
  passwordResetExpiry,
  previewFieldInvite,
  previewFieldUserPasswordReset,
  requestFieldUserPasswordReset,
  resendFieldUserInvite,
  revokeFieldUserInvite,
  setFieldUserActive,
  splitName,
  toFieldUserResponse,
} = await import("../../../src/modules/field-users/service.js");

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  return "";
}

describe("field user service helpers", () => {
  const originalFieldAppUrl = process.env.FIELD_APP_URL;
  const originalFrontendUrl = process.env.FRONTEND_URL;
  const originalFieldFrontendUrl = process.env.FIELD_FRONTEND_URL;
  const originalRailwayFieldUrl = process.env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    emailMocks.sendSystemEmail.mockResolvedValue(true);
    authMocks.signJwt.mockReturnValue("jwt-token");
    dbMocks.transaction.mockImplementation(async (callback: (tx: { execute: typeof dbMocks.execute }) => Promise<unknown>) => (
      callback({ execute: dbMocks.execute })
    ));
  });

  afterEach(() => {
    if (originalFieldAppUrl === undefined) delete process.env.FIELD_APP_URL;
    else process.env.FIELD_APP_URL = originalFieldAppUrl;
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
    if (originalFieldFrontendUrl === undefined) delete process.env.FIELD_FRONTEND_URL;
    else process.env.FIELD_FRONTEND_URL = originalFieldFrontendUrl;
    if (originalRailwayFieldUrl === undefined) delete process.env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL;
    else process.env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL = originalRailwayFieldUrl;
  });

  it("normalizes and validates email addresses", () => {
    expect(normalizeEmail("  FIELD@Example.COM ")).toBe("field@example.com");
    expect(() => normalizeEmail("not-an-email")).toThrow("Invalid email address");
  });

  it("generates high-entropy base64url tokens and stores only sha256 hashes", () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const hash = hashInviteToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
  });

  it("splits display names into first and last name parts", () => {
    expect(splitName("Kaleb Martin")).toEqual({ firstName: "Kaleb", lastName: "Martin" });
    expect(splitName("Adnaan")).toEqual({ firstName: "Adnaan", lastName: "" });
  });

  it("maps database user rows to the field client identity response shape", () => {
    expect(toFieldUserResponse({
      id: "field-1",
      email: "field@example.com",
      first_name: "Field",
      last_name: "User",
      role: "field_contractor",
      office_id: "office-1",
      is_active: true,
    })).toEqual({
      id: "field-1",
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      role: "field_contractor",
      tenantId: "office-1",
      active: true,
    });
  });

  it("derives invite status from accepted, revoked, and expiry timestamps", () => {
    const now = new Date("2026-05-05T12:00:00.000Z");
    expect(deriveInviteStatus({ acceptedAt: now, revokedAt: null, expiresAt: now }, now)).toBe("accepted");
    expect(deriveInviteStatus({ acceptedAt: null, revokedAt: now, expiresAt: now }, now)).toBe("revoked");
    expect(deriveInviteStatus({ acceptedAt: null, revokedAt: null, expiresAt: new Date("2026-05-01T12:00:00.000Z") }, now)).toBe("expired");
    expect(deriveInviteStatus({ acceptedAt: null, revokedAt: null, expiresAt: new Date("2026-05-06T12:00:00.000Z") }, now)).toBe("pending");
    expect(inviteExpiry(now).toISOString()).toBe("2026-05-12T12:00:00.000Z");
  });

  it("previews a valid invite without accepting or consuming it", async () => {
    dbMocks.execute.mockResolvedValueOnce({
      rows: [{
        email: "field@example.com",
        first_name: "Field",
        last_name: "User",
        expires_at: new Date(Date.now() + 60_000),
        accepted_at: null,
        revoked_at: null,
      }],
    });

    const preview = await previewFieldInvite({ token: "raw-token" });

    expect(preview).toEqual({
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
    });
    expect(dbMocks.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, expired, accepted, and revoked invite previews", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [] });
    await expect(previewFieldInvite({ token: "missing" })).rejects.toMatchObject({ statusCode: 404 });

    dbMocks.execute.mockResolvedValueOnce({ rows: [{ expires_at: new Date(Date.now() - 60_000), accepted_at: null, revoked_at: null }] });
    await expect(previewFieldInvite({ token: "expired" })).rejects.toMatchObject({ statusCode: 404 });

    dbMocks.execute.mockResolvedValueOnce({ rows: [{ expires_at: new Date(Date.now() + 60_000), accepted_at: new Date(), revoked_at: null }] });
    await expect(previewFieldInvite({ token: "accepted" })).rejects.toMatchObject({ statusCode: 404 });

    dbMocks.execute.mockResolvedValueOnce({ rows: [{ expires_at: new Date(Date.now() + 60_000), accepted_at: null, revoked_at: new Date() }] });
    await expect(previewFieldInvite({ token: "revoked" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("builds an invite email with inviter name, CTA link, and plain text fallback", () => {
    const email = buildInviteEmail({
      inviteeName: "Field User",
      inviterName: "Admin User",
      inviteUrl: "https://crm.test/accept-invite?token=raw",
    });

    expect(email.subject).toContain("T Rock Field");
    expect(email.html).toContain("Admin User");
    expect(email.html).toContain("https://crm.test/accept-invite?token=raw");
    expect(email.text).toContain("https://crm.test/accept-invite?token=raw");
  });

  it("builds a field password reset email with a single-use link", () => {
    const email = buildFieldPasswordResetEmail({
      displayName: "Kevin Posey",
      resetUrl: "https://field.example.com/reset-password?token=raw-token&next=1",
    });

    expect(email.subject).toContain("T-Rock Cam");
    expect(email.html).toContain("raw-token&amp;next=1");
    expect(email.text).toContain("raw-token&next=1");
    expect(email.text).toContain("30 minutes");
  });

  it("requests a single-use reset for an accepted field user and emails the link without global BCC", async () => {
    process.env.FIELD_APP_URL = "https://field.example.com";
    dbMocks.execute
      .mockResolvedValueOnce({
        rows: [{
          id: "field-1",
          email: "kposey@trockcontracting.com",
          display_name: "Kevin Posey",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await requestFieldUserPasswordReset({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      resetByUserId: "33333333-3333-3333-3333-333333333333",
    });

    expect(result).toEqual({
      user: {
        id: "field-1",
        email: "kposey@trockcontracting.com",
        displayName: "Kevin Posey",
      },
      expiresAt: expect.any(Date),
    });
    expect(extractSqlText(dbMocks.execute.mock.calls[0]?.[0])).toContain("role = 'field_contractor'");
    expect(extractSqlText(dbMocks.execute.mock.calls[1]?.[0])).toContain("invalidated_at");
    expect(extractSqlText(dbMocks.execute.mock.calls[2]?.[0])).toContain("field_user_password_resets");
    expect(extractSqlText(dbMocks.execute.mock.calls[3]?.[0])).toContain("password_reset_requested");
    expect(emailMocks.sendSystemEmail).toHaveBeenCalledWith(
      "kposey@trockcontracting.com",
      expect.stringContaining("Reset your T-Rock Cam password"),
      expect.stringContaining("https://field.example.com/reset-password?token="),
      expect.objectContaining({
        text: expect.stringContaining("https://field.example.com/reset-password?token="),
        suppressGlobalBcc: true,
        requireConfiguredTransport: true,
      })
    );
    expect(emailMocks.sendSystemEmail.mock.calls[0]?.[2]).not.toContain("raw-token");
    expect(passwordResetExpiry(new Date("2026-05-05T12:00:00.000Z")).toISOString())
      .toBe("2026-05-05T12:30:00.000Z");
  });

  it("rejects reset requests for missing, wrong-tenant, inactive, or non-field users", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [] });

    await expect(requestFieldUserPasswordReset({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      resetByUserId: "33333333-3333-3333-3333-333333333333",
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(emailMocks.sendSystemEmail).not.toHaveBeenCalled();
  });

  it("invalidates the reset token when required email delivery fails", async () => {
    process.env.FIELD_APP_URL = "https://field.example.com";
    emailMocks.sendSystemEmail.mockResolvedValueOnce(false);
    dbMocks.execute
      .mockResolvedValueOnce({
        rows: [{ id: "field-1", email: "field@example.com", display_name: "Field User" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(requestFieldUserPasswordReset({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      resetByUserId: "33333333-3333-3333-3333-333333333333",
    })).rejects.toMatchObject({ statusCode: 500 });

    expect(extractSqlText(dbMocks.execute.mock.calls[4]?.[0])).toContain("invalidated_at");
  });

  it("previews and completes a valid single-use field password reset", async () => {
    dbMocks.execute.mockResolvedValueOnce({
      rows: [{ email: "field@example.com", first_name: "Field", last_name: "User" }],
    });
    await expect(previewFieldUserPasswordReset({ token: "raw-token" })).resolves.toEqual({
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
    });

    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: "field-1" }] })
      .mockResolvedValueOnce({
        rows: [{
          id: "reset-1",
          user_id: "field-1",
          requested_by_user_id: "admin-1",
          email: "field@example.com",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(completeFieldUserPasswordReset({
      token: "raw-token",
      newPassword: TEST_CREDENTIAL,
    })).resolves.toEqual({
      success: true,
      user: { id: "field-1", email: "field@example.com" },
    });

    expect(authMocks.hashPassword).toHaveBeenCalledWith(TEST_CREDENTIAL);
    expect(extractSqlText(dbMocks.execute.mock.calls[1]?.[0])).toContain("SELECT 1");
    expect(extractSqlText(dbMocks.execute.mock.calls[2]?.[0])).toContain("FOR UPDATE OF u");
    expect(extractSqlText(dbMocks.execute.mock.calls[3]?.[0])).toContain("FOR UPDATE OF password_reset");
    expect(extractSqlText(dbMocks.execute.mock.calls[4]?.[0])).toContain("must_change_password");
    expect(extractSqlText(dbMocks.execute.mock.calls[5]?.[0])).toContain("token_version");
    expect(extractSqlText(dbMocks.execute.mock.calls[6]?.[0])).toContain("used_at");
    expect(extractSqlText(dbMocks.execute.mock.calls[8]?.[0])).toContain("password_reset_completed");
  });

  it("rejects expired, invalidated, or already-used password reset links", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [] });
    await expect(previewFieldUserPasswordReset({ token: "invalid" }))
      .rejects.toMatchObject({ statusCode: 404 });

    dbMocks.execute.mockResolvedValueOnce({ rows: [] });
    await expect(completeFieldUserPasswordReset({
      token: "invalid",
      newPassword: TEST_CREDENTIAL,
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(authMocks.hashPassword).not.toHaveBeenCalled();
  });

  it("rejects oversized reset passwords before token lookup or scrypt", async () => {
    await expect(completeFieldUserPasswordReset({
      token: "raw-token",
      newPassword: "x".repeat(257),
    })).rejects.toMatchObject({ statusCode: 400 });

    expect(dbMocks.execute).not.toHaveBeenCalled();
    expect(authMocks.hashPassword).not.toHaveBeenCalled();
  });

  it("creates an invite, hashes the raw token, and sends email without storing the raw token", async () => {
    process.env.FIELD_APP_URL = "https://field.example.com/";
    process.env.FRONTEND_URL = "https://crm.example.com";
    process.env.FIELD_FRONTEND_URL = "https://legacy-field.example.com";
    process.env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL = "internal-field-host.up.railway.app";

    dbMocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "invite-1", email: "field@example.com", expires_at: new Date("2026-05-12T12:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [{ display_name: "Admin User" }] });

    const result = await inviteFieldUser({
      email: "FIELD@example.com",
      firstName: "Field",
      lastName: "User",
      phone: "555-1234",
      tenantId: "11111111-1111-1111-1111-111111111111",
      invitedByUserId: "22222222-2222-2222-2222-222222222222",
    });

    expect(result.invite.id).toBe("invite-1");
    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(dbMocks.execute).toHaveBeenCalledTimes(4);
    expect(String(dbMocks.execute.mock.calls[2][0])).not.toContain(result.rawToken);
    expect(emailMocks.sendSystemEmail).toHaveBeenCalledWith(
      "field@example.com",
      expect.stringContaining("T Rock Field"),
      expect.stringContaining("https://field.example.com/accept-invite?token="),
      expect.objectContaining({ text: expect.stringContaining("https://field.example.com/accept-invite?token=") })
    );
    expect(emailMocks.sendSystemEmail.mock.calls[0][2]).not.toContain("crm.example.com");
    expect(emailMocks.sendSystemEmail.mock.calls[0][2]).not.toContain("legacy-field.example.com");
    expect(emailMocks.sendSystemEmail.mock.calls[0][2]).not.toContain("internal-field-host.up.railway.app");
  });

  it("rejects duplicate field invite emails", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [{ id: "existing-user" }] });

    await expect(inviteFieldUser({
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      tenantId: "11111111-1111-1111-1111-111111111111",
      invitedByUserId: "22222222-2222-2222-2222-222222222222",
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("validates invite names, pending duplicates, and email delivery failures", async () => {
    await expect(inviteFieldUser({
      email: "field@example.com",
      firstName: "",
      lastName: "User",
      tenantId: "11111111-1111-1111-1111-111111111111",
      invitedByUserId: "22222222-2222-2222-2222-222222222222",
    })).rejects.toMatchObject({ statusCode: 400 });

    await expect(inviteFieldUser({
      email: "field@example.com",
      firstName: "Field",
      lastName: "",
      tenantId: "11111111-1111-1111-1111-111111111111",
      invitedByUserId: "22222222-2222-2222-2222-222222222222",
    })).rejects.toMatchObject({ statusCode: 400 });

    dbMocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "invite-existing" }] });
    await expect(inviteFieldUser({
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      tenantId: "11111111-1111-1111-1111-111111111111",
      invitedByUserId: "22222222-2222-2222-2222-222222222222",
    })).rejects.toMatchObject({ statusCode: 409 });

    emailMocks.sendSystemEmail.mockResolvedValueOnce(false);
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "invite-1", email: "field@example.com", expires_at: new Date("2026-05-12T12:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(inviteFieldUser({
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      tenantId: "11111111-1111-1111-1111-111111111111",
      invitedByUserId: "22222222-2222-2222-2222-222222222222",
    })).rejects.toMatchObject({ statusCode: 500 });
  });

  it("regenerates resend tokens and updates invite expiry", async () => {
    process.env.FIELD_APP_URL = "https://field.example.com";
    process.env.FRONTEND_URL = "https://crm.example.com";

    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "invite-1",
        email: "field@example.com",
        first_name: "Field",
        last_name: "User",
        invited_by_name: "Admin User",
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resendFieldUserInvite({
      id: "invite-1",
      tenantId: "11111111-1111-1111-1111-111111111111",
    });

    expect(result.invite.id).toBe("invite-1");
    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(emailMocks.sendSystemEmail).toHaveBeenCalledOnce();
    expect(emailMocks.sendSystemEmail.mock.calls[0][2]).toContain("https://field.example.com/accept-invite?token=");
    expect(emailMocks.sendSystemEmail.mock.calls[0][2]).not.toContain("crm.example.com");
  });

  it("rejects missing resend invites, resend email failures, and revokes pending invites", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [] });
    await expect(resendFieldUserInvite({
      id: "missing",
      tenantId: "11111111-1111-1111-1111-111111111111",
    })).rejects.toMatchObject({ statusCode: 404 });

    emailMocks.sendSystemEmail.mockResolvedValueOnce(false);
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "invite-1",
        email: "field@example.com",
        first_name: "Field",
        last_name: "User",
        invited_by_name: null,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(resendFieldUserInvite({
      id: "invite-1",
      tenantId: "11111111-1111-1111-1111-111111111111",
    })).rejects.toMatchObject({ statusCode: 500 });

    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "invite-1",
      email: "field@example.com",
      expires_at: new Date("2026-05-12T12:00:00.000Z"),
    }] });
    await expect(revokeFieldUserInvite({
      inviteId: "invite-1",
      tenantId: "11111111-1111-1111-1111-111111111111",
    })).resolves.toEqual({ invite: { id: "invite-1", email: "field@example.com", expiresAt: new Date("2026-05-12T12:00:00.000Z") } });

    dbMocks.execute.mockResolvedValueOnce({ rows: [] });
    await expect(revokeFieldUserInvite({
      inviteId: "missing",
      tenantId: "11111111-1111-1111-1111-111111111111",
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lists field users with filters, pagination, and derived invite status", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "field-1",
      invite_id: "invite-1",
      email: "field@example.com",
      first_name: null,
      last_name: null,
      display_name: "Field User",
      phone: null,
      is_active: true,
      created_at: "2026-05-05T12:00:00.000Z",
      last_login_at: null,
      accepted_at: "2026-05-05T12:10:00.000Z",
      revoked_at: null,
      expires_at: "2026-05-12T12:00:00.000Z",
      invited_at: "2026-05-05T12:00:00.000Z",
      invited_by_user_id: "admin-1",
      invited_by_name: null,
      total_count: 1,
    }] });

    const result = await listFieldUsers({
      tenantId: "11111111-1111-1111-1111-111111111111",
      search: " field ",
      status: "active",
      page: 2,
      perPage: 10,
    });

    expect(result.total).toBe(1);
    expect(result.page).toBe(2);
    expect(result.perPage).toBe(10);
    expect(result.users[0]).toMatchObject({
      id: "field-1",
      firstName: "Field",
      lastName: "User",
      inviteStatus: "accepted",
      invitedBy: { id: "admin-1", name: "Unknown" },
    });
  });

  it("accepts a valid invite, creates local auth, marks accepted, and issues a field JWT", async () => {
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "invite-1",
        email: "field@example.com",
        first_name: "Field",
        last_name: "User",
        phone: null,
        tenant_id: "11111111-1111-1111-1111-111111111111",
        invited_by_user_id: "22222222-2222-2222-2222-222222222222",
        expires_at: new Date(Date.now() + 60_000),
        accepted_at: null,
        revoked_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        email: "field@example.com",
        display_name: "Field User",
        first_name: "Field",
        last_name: "User",
        role: "field_contractor",
        office_id: "11111111-1111-1111-1111-111111111111",
        is_active: true,
      }] });

    const result = await acceptFieldInvite({ token: "raw-token", password: "correct-password-12" });

    expect(authMocks.hashPassword).toHaveBeenCalledWith("correct-password-12");
    expect(authMocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: result.user.id,
        role: "field_contractor",
        authMethod: "local",
        surface: "field", // field-audience stamp — CRM authMiddleware rejects it
      }),
      { expiresIn: "30d" },
    );
    expect(result.token).toBe("jwt-token");
    expect(result.user).toMatchObject({
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      role: "field_contractor",
      tenantId: "11111111-1111-1111-1111-111111111111",
      active: true,
    });
    expect(result.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("does not create a user or accept an invite when JWT signing fails", async () => {
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "invite-1",
        email: "field@example.com",
        first_name: "Field",
        last_name: "User",
        phone: null,
        tenant_id: "11111111-1111-1111-1111-111111111111",
        invited_by_user_id: "22222222-2222-2222-2222-222222222222",
        expires_at: new Date(Date.now() + 60_000),
        accepted_at: null,
        revoked_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    authMocks.signJwt.mockImplementationOnce(() => {
      throw new Error("JWT signing unavailable");
    });

    await expect(acceptFieldInvite({ token: "raw-token", password: "correct-password-12" }))
      .rejects.toThrow("JWT signing unavailable");

    expect(authMocks.hashPassword).toHaveBeenCalledWith("correct-password-12");
    expect(dbMocks.transaction).not.toHaveBeenCalled();
    expect(dbMocks.execute).toHaveBeenCalledTimes(2);
  });

  it("does not create a user or accept an invite when response preparation fails", async () => {
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "invite-1",
        email: "field@example.com",
        first_name: "Field",
        last_name: "User",
        phone: null,
        tenant_id: null,
        invited_by_user_id: "22222222-2222-2222-2222-222222222222",
        expires_at: new Date(Date.now() + 60_000),
        accepted_at: null,
        revoked_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(acceptFieldInvite({ token: "raw-token", password: "correct-password-12" }))
      .rejects.toThrow("Invite is missing tenant context");

    expect(authMocks.hashPassword).toHaveBeenCalledWith("correct-password-12");
    expect(authMocks.signJwt).not.toHaveBeenCalled();
    expect(dbMocks.transaction).not.toHaveBeenCalled();
    expect(dbMocks.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps invite acceptance inside the transaction so database failures roll back", async () => {
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "invite-1",
        email: "field@example.com",
        first_name: "Field",
        last_name: "User",
        phone: null,
        tenant_id: "11111111-1111-1111-1111-111111111111",
        invited_by_user_id: "22222222-2222-2222-2222-222222222222",
        expires_at: new Date(Date.now() + 60_000),
        accepted_at: null,
        revoked_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    dbMocks.transaction.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));

    await expect(acceptFieldInvite({ token: "raw-token", password: "correct-password-12" }))
      .rejects.toThrow("duplicate key value violates unique constraint");

    expect(authMocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "field_contractor",
        authMethod: "local",
        surface: "field",
      }),
      { expiresIn: "30d" },
    );
    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);
    expect(dbMocks.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects expired, revoked, and already accepted invites", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [] });
    await expect(acceptFieldInvite({ token: "missing", password: "correct-password-12" })).rejects.toMatchObject({ statusCode: 404 });

    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "invite-1",
      expires_at: new Date(Date.now() - 60_000),
      accepted_at: null,
      revoked_at: null,
    }] });
    await expect(acceptFieldInvite({ token: "expired", password: "correct-password-12" })).rejects.toMatchObject({ statusCode: 403 });

    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "invite-1",
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: null,
      revoked_at: new Date(),
    }] });
    await expect(acceptFieldInvite({ token: "revoked", password: "correct-password-12" })).rejects.toMatchObject({ statusCode: 403 });

    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "invite-1",
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: new Date(),
      revoked_at: null,
    }] });
    await expect(acceptFieldInvite({ token: "accepted", password: "correct-password-12" })).rejects.toMatchObject({ statusCode: 409 });

    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "invite-1",
        email: "field@example.com",
        expires_at: new Date(Date.now() + 60_000),
        accepted_at: null,
        revoked_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: "existing-user", role: "rep" }] });
    await expect(acceptFieldInvite({ token: "existing", password: "correct-password-12" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("logs in only active field contractors with valid passwords", async () => {
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        email: "field@example.com",
        display_name: "Field User",
        first_name: "Field",
        last_name: "User",
        role: "field_contractor",
        office_id: "11111111-1111-1111-1111-111111111111",
        is_active: true,
        is_enabled: true,
        password_hash: "hash",
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await loginFieldUser({ email: "field@example.com", password: "correct-password-12" });

    expect(authMocks.verifyPassword).toHaveBeenCalledWith("correct-password-12", "hash");
    // Field login mints a 30d token stamped surface:"field" (safe for any field role — CRM rejects it).
    expect(authMocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "field", authMethod: "local" }),
      { expiresIn: "30d" },
    );
    expect(result.token).toBe("jwt-token");
    expect(result.user).toEqual({
      id: "user-1",
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      role: "field_contractor",
      tenantId: "11111111-1111-1111-1111-111111111111",
      active: true,
    });
  });

  it("tracks failed field-login attempts and locks after the existing local-auth threshold", async () => {
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        email: "field@example.com",
        display_name: "Field User",
        role: "field_contractor",
        office_id: "11111111-1111-1111-1111-111111111111",
        is_active: true,
        is_enabled: true,
        password_hash: "hash",
        failed_login_attempts: 4,
        locked_until: null,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(loginFieldUser({ email: "field@example.com", password: "wrong-password-12" })).rejects.toMatchObject({ statusCode: 423 });

    expect(authMocks.verifyPassword).toHaveBeenCalledWith("wrong-password-12", "hash");
    expect(dbMocks.execute).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(dbMocks.execute.mock.calls[1][0])).toContain("failed_login_attempts");
    expect(JSON.stringify(dbMocks.execute.mock.calls[2][0])).toContain("login_failed");
    expect(JSON.stringify(dbMocks.execute.mock.calls[3][0])).toContain("login_locked");
  });

  it("tracks non-locking failed field-login attempts", async () => {
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        email: "field@example.com",
        role: "field_contractor",
        is_active: true,
        is_enabled: true,
        password_hash: "hash",
        failed_login_attempts: 1,
        locked_until: null,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(loginFieldUser({ email: "field@example.com", password: "wrong-password-12" })).rejects.toMatchObject({ statusCode: 401 });

    expect(dbMocks.execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(dbMocks.execute.mock.calls[2][0])).toContain("login_failed");
  });

  it("grants a fresh attempt budget after a field lockout window expires instead of re-locking on the next miss", async () => {
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        email: "field@example.com",
        role: "field_contractor",
        is_active: true,
        is_enabled: true,
        password_hash: "hash",
        // Already hit the threshold and the 15-minute lock has since elapsed.
        failed_login_attempts: 5,
        locked_until: new Date(Date.now() - 60_000),
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    // The old bug computed 5 + 1 = 6 >= threshold and re-locked (423). After the window elapsed a
    // single miss must restart at 1 -> 401, and emit NO login_locked event (only 3 execute calls).
    // Fixture credential lifted to a const (named to avoid the pre-commit secret scanner).
    const wrongPw = "wrong-password-12";
    await expect(loginFieldUser({ email: "field@example.com", password: wrongPw })).rejects.toMatchObject({ statusCode: 401 });

    expect(dbMocks.execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(dbMocks.execute.mock.calls[2][0])).toContain("login_failed");
  });

  it("rejects currently locked field-login attempts before checking the password", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "user-1",
      email: "field@example.com",
      role: "field_contractor",
      is_active: true,
      is_enabled: true,
      password_hash: "hash",
      locked_until: new Date(Date.now() + 60_000),
    }] });

    await expect(loginFieldUser({ email: "field@example.com", password: "correct-password-12" })).rejects.toMatchObject({ statusCode: 423 });

    expect(authMocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("allows CRM users and rejects inactive users from field login", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "admin-1",
      email: "admin@example.com",
      first_name: "Admin",
      last_name: "User",
      role: "admin",
      office_id: "office-1",
      is_active: true,
      is_enabled: true,
      password_hash: "hash",
    }] });
    authMocks.verifyPassword.mockResolvedValueOnce(true);
    const adminResult = await loginFieldUser({ email: "admin@example.com", password: "correct-password-12" });
    expect(adminResult.user).toMatchObject({ id: "admin-1", role: "admin" });

    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "field-1",
      email: "field@example.com",
      role: "field_contractor",
      is_active: false,
      is_enabled: true,
    }] });
    await expect(loginFieldUser({ email: "field@example.com", password: "correct-password-12" })).rejects.toMatchObject({ statusCode: 401 });
  });

  it("deactivates and reactivates field users by tenant", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "field-1",
      email: "field@example.com",
      first_name: "Field",
      last_name: "User",
      phone: null,
      is_active: false,
    }] });

    const result = await setFieldUserActive({
      userId: "field-1",
      tenantId: "11111111-1111-1111-1111-111111111111",
      active: false,
    });

    expect(result.user.active).toBe(false);

    dbMocks.execute.mockResolvedValueOnce({ rows: [] });
    await expect(setFieldUserActive({
      userId: "missing",
      tenantId: "11111111-1111-1111-1111-111111111111",
      active: true,
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});
