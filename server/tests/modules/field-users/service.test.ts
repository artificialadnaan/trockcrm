import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));
const emailMocks = vi.hoisted(() => ({
  sendSystemEmail: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async (password: string) => `hash:${password}`),
  verifyPassword: vi.fn(async (password: string) => password === "correct-password-12"),
  signJwt: vi.fn(() => "jwt-token"),
}));

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
  buildInviteEmail,
  deriveInviteStatus,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteFieldUser,
  listFieldUsers,
  loginFieldUser,
  normalizeEmail,
  resendFieldUserInvite,
  revokeFieldUserInvite,
  setFieldUserActive,
  splitName,
} = await import("../../../src/modules/field-users/service.js");

describe("field user service helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emailMocks.sendSystemEmail.mockResolvedValue(true);
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

  it("derives invite status from accepted, revoked, and expiry timestamps", () => {
    const now = new Date("2026-05-05T12:00:00.000Z");
    expect(deriveInviteStatus({ acceptedAt: now, revokedAt: null, expiresAt: now }, now)).toBe("accepted");
    expect(deriveInviteStatus({ acceptedAt: null, revokedAt: now, expiresAt: now }, now)).toBe("revoked");
    expect(deriveInviteStatus({ acceptedAt: null, revokedAt: null, expiresAt: new Date("2026-05-01T12:00:00.000Z") }, now)).toBe("expired");
    expect(deriveInviteStatus({ acceptedAt: null, revokedAt: null, expiresAt: new Date("2026-05-06T12:00:00.000Z") }, now)).toBe("pending");
    expect(inviteExpiry(now).toISOString()).toBe("2026-05-12T12:00:00.000Z");
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

  it("creates an invite, hashes the raw token, and sends email without storing the raw token", async () => {
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
      expect.stringContaining("/accept-invite?token="),
      expect.objectContaining({ text: expect.stringContaining("/accept-invite?token=") })
    );
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
        role: "field_contractor",
        office_id: "11111111-1111-1111-1111-111111111111",
      }] });

    const result = await acceptFieldInvite({ token: "raw-token", password: "correct-password-12" });

    expect(authMocks.hashPassword).toHaveBeenCalledWith("correct-password-12");
    expect(authMocks.signJwt).toHaveBeenCalledWith(expect.objectContaining({
      role: "field_contractor",
      authMethod: "local",
    }));
    expect(result.token).toBe("jwt-token");
    expect(result.user.role).toBe("field_contractor");
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
        role: "field_contractor",
        office_id: "11111111-1111-1111-1111-111111111111",
        is_active: true,
        is_enabled: true,
        password_hash: "hash",
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await loginFieldUser({ email: "field@example.com", password: "correct-password-12" });

    expect(authMocks.verifyPassword).toHaveBeenCalledWith("correct-password-12", "hash");
    expect(result.token).toBe("jwt-token");
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

  it("rejects CRM users and inactive field users from field login", async () => {
    dbMocks.execute.mockResolvedValueOnce({ rows: [{
      id: "admin-1",
      email: "admin@example.com",
      role: "admin",
      is_active: true,
      is_enabled: true,
    }] });
    await expect(loginFieldUser({ email: "admin@example.com", password: "correct-password-12" })).rejects.toMatchObject({ statusCode: 401 });

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
