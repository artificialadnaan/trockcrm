import crypto from "crypto";
import { sql } from "drizzle-orm";
import type { UserRole } from "@trock-crm/shared/types";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { sendSystemEmail } from "../../lib/resend-client.js";
import { hashPassword, verifyPassword } from "../auth/local-auth-service.js";
import { signJwt } from "../auth/service.js";
import { getFieldAppUrl } from "../auth/http-config.js";

const INVITE_TOKEN_BYTES = 32;
const INVITE_TTL_DAYS = 7;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MINUTES = 15;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// FIELD session lifetime — long-lived so crews don't re-authenticate every time they open T-Rock Cam.
// Applied ONLY to pure field_contractor tokens (invites are always field_contractor; field-login uses it
// only when the user's role is field_contractor). CRM-capable roles (admin/director/rep/construction)
// that can also field-login keep the 24h default, since their token works on CRM routes too. The CRM/admin
// signer default (24h) is untouched. Tradeoff: a stateless 30-day token has no server-side revocation yet
// (tracked follow-up).
const FIELD_JWT_EXPIRES_IN = "30d";

export type InviteStatus = "accepted" | "pending" | "expired" | "revoked";
export type FieldUserStatusFilter = "all" | "active" | "inactive" | "pending-invite";

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    throw new AppError(400, "Invalid email address");
  }
  return normalized;
}

export function generateInviteToken(): string {
  return crypto.randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function splitName(displayName: string): { firstName: string; lastName: string } {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

export function inviteExpiry(baseDate = new Date()): Date {
  return new Date(baseDate.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function deriveInviteStatus(
  input: { acceptedAt: Date | string | null; revokedAt: Date | string | null; expiresAt: Date | string },
  now = new Date()
): InviteStatus {
  if (input.acceptedAt) return "accepted";
  if (input.revokedAt) return "revoked";
  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  return expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}

export type FieldUserResponse = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  tenantId: string;
  active: boolean;
};

const FIELD_APP_ALLOWED_ROLE_SET = new Set<UserRole>([
  "admin",
  "director",
  "rep",
  "construction",
  "field_contractor",
]);

export function toFieldUserResponse(row: {
  id: string;
  email: string;
  first_name?: string | null;
  firstName?: string | null;
  last_name?: string | null;
  lastName?: string | null;
  role: string;
  office_id?: string | null;
  tenantId?: string | null;
  is_active?: boolean | null;
  active?: boolean | null;
}): FieldUserResponse {
  if (!FIELD_APP_ALLOWED_ROLE_SET.has(row.role as UserRole)) {
    throw new AppError(500, "Field app user has an unsupported role");
  }
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName ?? row.first_name ?? null,
    lastName: row.lastName ?? row.last_name ?? null,
    role: row.role as UserRole,
    tenantId: row.tenantId ?? row.office_id ?? "",
    active: Boolean(row.active ?? row.is_active),
  };
}

export function buildInviteEmail(input: {
  inviteeName: string;
  inviterName: string;
  inviteUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = "You've been invited to join T Rock Field";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111827">
      <p>Hi ${input.inviteeName},</p>
      <p>${input.inviterName} invited you to join T Rock Field so you can access project photos and field workflows.</p>
      <p>
        <a href="${input.inviteUrl}" style="display:inline-block;background:#b91c1c;color:#ffffff;padding:10px 14px;border-radius:6px;text-decoration:none;font-weight:600">
          Accept invite
        </a>
      </p>
      <p>This invite expires in 7 days. If you were not expecting this invite, you can ignore this email.</p>
    </div>
  `;
  const text = [
    `Hi ${input.inviteeName},`,
    "",
    `${input.inviterName} invited you to join T Rock Field so you can access project photos and field workflows.`,
    `Accept invite: ${input.inviteUrl}`,
    "",
    "This invite expires in 7 days. If you were not expecting this invite, you can ignore this email.",
  ].join("\n");
  return { subject, html, text };
}

function fieldInviteUrl(rawToken: string): string {
  const base = getFieldAppUrl(process.env);
  return `${base.replace(/\/+$/, "")}/accept-invite?token=${encodeURIComponent(rawToken)}`;
}

function mapFieldUserRow(row: any, now = new Date()) {
  const inviteStatus = row.invite_id
    ? deriveInviteStatus({
        acceptedAt: row.accepted_at,
        revokedAt: row.revoked_at,
        expiresAt: row.expires_at,
      }, now)
    : row.id
      ? "accepted"
      : "pending";
  return {
    id: row.id ?? row.invite_id,
    userId: row.id ?? null,
    inviteId: row.invite_id ?? null,
    email: row.email,
    firstName: row.first_name ?? splitName(row.display_name ?? "").firstName,
    lastName: row.last_name ?? splitName(row.display_name ?? "").lastName,
    phone: row.phone ?? null,
    active: row.is_active ?? false,
    createdAt: row.created_at ?? row.invited_at,
    lastLoginAt: row.last_login_at ?? null,
    inviteStatus,
    invitedBy: row.invited_by_user_id
      ? { id: row.invited_by_user_id, name: row.invited_by_name ?? "Unknown" }
      : null,
    invitedAt: row.invited_at ?? null,
    acceptedAt: row.accepted_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

export async function inviteFieldUser(input: {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  tenantId: string;
  invitedByUserId: string;
}) {
  const email = normalizeEmail(input.email);
  if (!input.firstName?.trim()) throw new AppError(400, "firstName is required");
  if (!input.lastName?.trim()) throw new AppError(400, "lastName is required");

  const existing = await db.execute(sql`
    SELECT id FROM users WHERE lower(email) = ${email} LIMIT 1
  `);
  if (((existing as any).rows ?? existing).length > 0) {
    throw new AppError(409, "A user with this email already exists");
  }

  const pending = await db.execute(sql`
    SELECT id FROM field_user_invites
    WHERE lower(email) = ${email}
      AND tenant_id = ${input.tenantId}::uuid
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `);
  if (((pending as any).rows ?? pending).length > 0) {
    throw new AppError(409, "A pending invite already exists for this email");
  }

  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = inviteExpiry();
  const inviteResult = await db.execute(sql`
    INSERT INTO field_user_invites (
      email,
      tenant_id,
      token_hash,
      first_name,
      last_name,
      phone,
      invited_by_user_id,
      expires_at,
      updated_at
    )
    VALUES (
      ${email},
      ${input.tenantId}::uuid,
      ${tokenHash},
      ${input.firstName.trim()},
      ${input.lastName.trim()},
      ${input.phone?.trim() || null},
      ${input.invitedByUserId}::uuid,
      ${expiresAt},
      now()
    )
    RETURNING id, email, expires_at
  `);
  const invite = ((inviteResult as any).rows ?? inviteResult)[0];

  const inviterResult = await db.execute(sql`
    SELECT display_name FROM users WHERE id = ${input.invitedByUserId}::uuid LIMIT 1
  `);
  const inviter = ((inviterResult as any).rows ?? inviterResult)[0];
  const emailContent = buildInviteEmail({
    inviteeName: `${input.firstName.trim()} ${input.lastName.trim()}`.trim(),
    inviterName: inviter?.display_name ?? "T Rock",
    inviteUrl: fieldInviteUrl(rawToken),
  });
  const sent = await sendSystemEmail(email, emailContent.subject, emailContent.html, { text: emailContent.text });
  if (!sent) throw new AppError(500, "Failed to send invite email");

  return {
    invite: {
      id: invite.id,
      email: invite.email,
      expiresAt: invite.expires_at,
    },
    rawToken,
  };
}

export async function resendFieldUserInvite(input: {
  id: string;
  tenantId: string;
}) {
  const result = await db.execute(sql`
    SELECT
      fui.id,
      fui.email,
      fui.first_name,
      fui.last_name,
      fui.invited_by_user_id,
      inviter.display_name AS invited_by_name
    FROM field_user_invites fui
    LEFT JOIN users inviter ON inviter.id = fui.invited_by_user_id
    WHERE fui.id = ${input.id}::uuid
      AND fui.tenant_id = ${input.tenantId}::uuid
      AND fui.accepted_at IS NULL
      AND fui.revoked_at IS NULL
    ORDER BY fui.created_at DESC
    LIMIT 1
  `);
  const invite = ((result as any).rows ?? result)[0];
  if (!invite) throw new AppError(404, "Pending invite not found");

  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = inviteExpiry();
  await db.execute(sql`
    UPDATE field_user_invites
    SET token_hash = ${tokenHash},
        expires_at = ${expiresAt},
        updated_at = now()
    WHERE id = ${invite.id}::uuid
  `);

  const emailContent = buildInviteEmail({
    inviteeName: `${invite.first_name} ${invite.last_name}`.trim(),
    inviterName: invite.invited_by_name ?? "T Rock",
    inviteUrl: fieldInviteUrl(rawToken),
  });
  const sent = await sendSystemEmail(invite.email, emailContent.subject, emailContent.html, { text: emailContent.text });
  if (!sent) throw new AppError(500, "Failed to send invite email");

  return { invite: { id: invite.id, email: invite.email, expiresAt }, rawToken };
}

export async function revokeFieldUserInvite(input: { inviteId: string; tenantId: string }) {
  const result = await db.execute(sql`
    UPDATE field_user_invites
    SET revoked_at = now(), updated_at = now()
    WHERE id = ${input.inviteId}::uuid
      AND tenant_id = ${input.tenantId}::uuid
      AND accepted_at IS NULL
      AND revoked_at IS NULL
    RETURNING id, email, expires_at
  `);
  const invite = ((result as any).rows ?? result)[0];
  if (!invite) throw new AppError(404, "Pending invite not found");
  return { invite: { id: invite.id, email: invite.email, expiresAt: invite.expires_at } };
}

export async function listFieldUsers(input: {
  tenantId: string;
  search?: string;
  status?: FieldUserStatusFilter;
  page?: number;
  perPage?: number;
}) {
  const page = Math.max(1, Number.isFinite(input.page) ? input.page! : 1);
  const perPage = Math.min(Math.max(1, Number.isFinite(input.perPage) ? input.perPage! : 25), 100);
  const offset = (page - 1) * perPage;
  const search = input.search?.trim() ? `%${input.search.trim()}%` : null;
  const status = input.status ?? "all";

  const result = await db.execute(sql`
    WITH field_rows AS (
      SELECT
        u.id,
        NULL::uuid AS invite_id,
        u.email,
        u.first_name,
        u.last_name,
        u.display_name,
        u.phone,
        u.is_active,
        u.created_at,
        ula.last_login_at,
        fui.accepted_at,
        fui.revoked_at,
        fui.expires_at,
        fui.created_at AS invited_at,
        fui.invited_by_user_id,
        inviter.display_name AS invited_by_name
      FROM users u
      LEFT JOIN user_local_auth ula ON ula.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT *
        FROM field_user_invites candidate
        WHERE candidate.accepted_user_id = u.id
        ORDER BY candidate.created_at DESC
        LIMIT 1
      ) fui ON true
      LEFT JOIN users inviter ON inviter.id = fui.invited_by_user_id
      WHERE u.role = 'field_contractor'
        AND u.office_id = ${input.tenantId}::uuid

      UNION ALL

      SELECT
        NULL::uuid AS id,
        fui.id AS invite_id,
        fui.email,
        fui.first_name,
        fui.last_name,
        NULL::varchar AS display_name,
        fui.phone,
        false AS is_active,
        fui.created_at,
        NULL::timestamptz AS last_login_at,
        fui.accepted_at,
        fui.revoked_at,
        fui.expires_at,
        fui.created_at AS invited_at,
        fui.invited_by_user_id,
        inviter.display_name AS invited_by_name
      FROM field_user_invites fui
      LEFT JOIN users inviter ON inviter.id = fui.invited_by_user_id
      WHERE fui.tenant_id = ${input.tenantId}::uuid
        AND fui.accepted_at IS NULL
    ),
    filtered AS (
      SELECT *
      FROM field_rows
      WHERE (${search}::text IS NULL
        OR email ILIKE ${search}
        OR first_name ILIKE ${search}
        OR last_name ILIKE ${search})
        AND (
          ${status} = 'all'
          OR (${status} = 'active' AND id IS NOT NULL AND is_active = true)
          OR (${status} = 'inactive' AND id IS NOT NULL AND is_active = false)
          OR (${status} = 'pending-invite' AND invite_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
        )
    )
    SELECT *, COUNT(*) OVER()::int AS total_count
    FROM filtered
    ORDER BY invited_at DESC NULLS LAST, created_at DESC
    LIMIT ${perPage} OFFSET ${offset}
  `);

  const rows = (result as any).rows ?? result;
  return {
    users: rows.map((row: any) => mapFieldUserRow(row)),
    total: Number(rows[0]?.total_count ?? 0),
    page,
    perPage,
  };
}

export async function setFieldUserActive(input: { userId: string; tenantId: string; active: boolean }) {
  const result = await db.execute(sql`
    UPDATE users
    SET is_active = ${input.active}, updated_at = now()
    WHERE id = ${input.userId}::uuid
      AND office_id = ${input.tenantId}::uuid
      AND role = 'field_contractor'
    RETURNING id, email, first_name, last_name, phone, is_active
  `);
  const user = ((result as any).rows ?? result)[0];
  if (!user) throw new AppError(404, "Field user not found");
  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      phone: user.phone,
      active: user.is_active,
    },
  };
}

export async function previewFieldInvite(input: { token: string }) {
  const tokenHash = hashInviteToken(input.token);
  const result = await db.execute(sql`
    SELECT email, first_name, last_name, expires_at, accepted_at, revoked_at
    FROM field_user_invites
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `);
  const invite = ((result as any).rows ?? result)[0];
  if (
    !invite ||
    invite.revoked_at ||
    invite.accepted_at ||
    new Date(invite.expires_at).getTime() <= Date.now()
  ) {
    throw new AppError(404, "Invite not found");
  }

  return {
    firstName: invite.first_name,
    lastName: invite.last_name,
    email: invite.email,
  };
}

export async function acceptFieldInvite(input: { token: string; password: string }) {
  const tokenHash = hashInviteToken(input.token);
  const inviteResult = await db.execute(sql`
    SELECT *
    FROM field_user_invites
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `);
  const invite = ((inviteResult as any).rows ?? inviteResult)[0];
  if (!invite) throw new AppError(404, "Invite not found");
  if (invite.revoked_at) throw new AppError(403, "Invite has been revoked");
  if (invite.accepted_at) throw new AppError(409, "Invite has already been accepted");
  if (new Date(invite.expires_at).getTime() <= Date.now()) throw new AppError(403, "Invite has expired");

  const existing = await db.execute(sql`SELECT id, role FROM users WHERE lower(email) = ${invite.email} LIMIT 1`);
  const existingUser = ((existing as any).rows ?? existing)[0];
  if (existingUser) {
    throw new AppError(409, "A user with this email already exists");
  }

  const passwordHash = await hashPassword(input.password);
  if (!invite.tenant_id) {
    throw new Error("Invite is missing tenant context");
  }

  // Build the field response and JWT before any write transaction. If signing
  // or response shaping ever fails, the invite remains pending and retryable.
  const user = {
    id: crypto.randomUUID(),
    email: invite.email,
    first_name: invite.first_name,
    last_name: invite.last_name,
    role: "field_contractor",
    office_id: invite.tenant_id,
    is_active: true,
  };
  const jwtToken = signJwt({
    userId: user.id,
    email: user.email,
    officeId: user.office_id,
    role: "field_contractor",
    authMethod: "local",
  }, { expiresIn: FIELD_JWT_EXPIRES_IN });
  const responseUser = toFieldUserResponse(user);

  await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      WITH created_user AS (
        INSERT INTO users (
          id,
          email,
          display_name,
          first_name,
          last_name,
          phone,
          role,
          office_id,
          is_active,
          created_by_user_id,
          updated_at
        )
        VALUES (
          ${user.id}::uuid,
          ${invite.email},
          ${`${invite.first_name} ${invite.last_name}`.trim()},
          ${invite.first_name},
          ${invite.last_name},
          ${invite.phone},
          'field_contractor',
          ${invite.tenant_id}::uuid,
          true,
          ${invite.invited_by_user_id}::uuid,
          now()
        )
        RETURNING id
      ),
      auth_row AS (
        INSERT INTO user_local_auth (
          user_id,
          password_hash,
          must_change_password,
          is_enabled,
          invite_sent_at,
          invite_sent_by_user_id,
          invite_expires_at,
          password_changed_at,
          updated_at
        )
        SELECT
          id,
          ${passwordHash},
          false,
          true,
          now(),
          ${invite.invited_by_user_id}::uuid,
          NULL,
          now(),
          now()
        FROM created_user
        RETURNING user_id
      )
      UPDATE field_user_invites
      SET accepted_at = now(),
          accepted_user_id = (SELECT id FROM created_user),
          updated_at = now()
      WHERE id = ${invite.id}::uuid
      RETURNING accepted_user_id
    `);
    const accepted = ((result as any).rows ?? result)[0];
    if (!accepted) {
      throw new Error("Failed to accept field invite");
    }
  });

  return {
    user: responseUser,
    token: jwtToken,
  };
}

export async function loginFieldUser(input: { email: string; password: string }) {
  const email = normalizeEmail(input.email);
  const result = await db.execute(sql`
    SELECT
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.role,
      u.office_id,
      u.is_active,
      ula.password_hash,
      ula.is_enabled,
      ula.failed_login_attempts,
      ula.locked_until
    FROM users u
    INNER JOIN user_local_auth ula ON ula.user_id = u.id
    WHERE lower(u.email) = ${email}
    LIMIT 1
  `);
  const user = ((result as any).rows ?? result)[0];
  if (!user || !FIELD_APP_ALLOWED_ROLE_SET.has(user.role as UserRole) || !user.is_active || !user.is_enabled) {
    throw new AppError(401, "Invalid email or password");
  }

  const currentTime = new Date();
  if (user.locked_until && new Date(user.locked_until).getTime() > currentTime.getTime()) {
    throw new AppError(423, "Field login is temporarily locked");
  }

  const passwordMatches = await verifyPassword(input.password, user.password_hash);
  if (!passwordMatches) {
    const failedLoginAttempts = Number(user.failed_login_attempts ?? 0) + 1;
    const lockedUntil = failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS
      ? new Date(currentTime.getTime() + LOCKOUT_WINDOW_MINUTES * 60 * 1000)
      : null;

    await db.execute(sql`
      UPDATE user_local_auth
      SET failed_login_attempts = ${failedLoginAttempts},
          last_failed_login_at = ${currentTime},
          locked_until = ${lockedUntil},
          updated_at = now()
      WHERE user_id = ${user.id}::uuid
    `);

    await db.execute(sql`
      INSERT INTO user_local_auth_events (user_id, event_type, metadata)
      VALUES (
        ${user.id}::uuid,
        'login_failed',
        ${JSON.stringify({ failedLoginAttempts })}::jsonb
      )
    `);

    if (lockedUntil) {
      await db.execute(sql`
        INSERT INTO user_local_auth_events (user_id, event_type, metadata)
        VALUES (
          ${user.id}::uuid,
          'login_locked',
          ${JSON.stringify({ lockedUntil: lockedUntil.toISOString() })}::jsonb
        )
      `);
      throw new AppError(423, "Field login is temporarily locked");
    }
    throw new AppError(401, "Invalid email or password");
  }

  // 30d ONLY for pure field users (field_contractor). loginFieldUser also admits CRM roles
  // (admin/director/rep/construction), and their token is usable on CRM/admin routes — so minting THOSE
  // for 30d would extend the CRM session past its 24h lifetime. CRM roles keep the 24h default.
  const jwtToken = signJwt({
    userId: user.id,
    email: user.email,
    officeId: user.office_id,
    role: user.role as UserRole,
    authMethod: "local",
  }, user.role === "field_contractor" ? { expiresIn: FIELD_JWT_EXPIRES_IN } : undefined);
  await db.execute(sql`
    UPDATE user_local_auth
    SET last_login_at = now(),
        failed_login_attempts = 0,
        last_failed_login_at = NULL,
        locked_until = NULL,
        updated_at = now()
    WHERE user_id = ${user.id}::uuid
  `);
  return {
    user: toFieldUserResponse(user),
    token: jwtToken,
  };
}
