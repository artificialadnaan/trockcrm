import crypto from "crypto";
import { promisify } from "util";
import { and, eq, sql } from "drizzle-orm";
import { dealTeamMembers, userLocalAuth, userLocalAuthEvents, users } from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { sendSystemEmail } from "../../lib/resend-client.js";
import type { UserRole } from "@trock-crm/shared/types";
import {
  listActiveFieldOffices,
  runInOfficeTransaction,
  type FieldOffice,
  type FieldTenantDb,
} from "../field/cross-office.js";
import { restartCorrectiveActionNotificationCycleForDeal } from "../field/corrective-actions-service.js";

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_MIN_LENGTH = 12;
const TEMP_PASSWORD_LENGTH = 18;
const INVITE_TTL_HOURS = 72;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MINUTES = 15;
const DEFAULT_CLEANUP_LOGIN_URL = "https://onboarding.trockcrm.com";

export type LocalAuthStatus =
  | "not_invited"
  | "invite_sent"
  | "password_change_required"
  | "active"
  | "disabled";
type LocalAuthUserRole = Exclude<UserRole, "field_contractor">;

function assertLocalAuthUserRole(role: UserRole): asserts role is LocalAuthUserRole {
  if (role === "field_contractor") {
    throw new AppError(403, "Local login is not available for this role");
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function now(): Date {
  return new Date();
}

function computeInviteExpiry(baseDate: Date): Date {
  return new Date(baseDate.getTime() + INVITE_TTL_HOURS * 60 * 60 * 1000);
}

function computeLockoutUntil(baseDate: Date): Date {
  return new Date(baseDate.getTime() + LOCKOUT_WINDOW_MINUTES * 60 * 1000);
}

function validatePasswordPolicy(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      400,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
    );
  }
}

type InviteEmailContent = {
  subject: string;
  html: string;
  text: string;
  loginUrl: string;
  recipientEmail: string;
};

function buildUserPayload(user: {
  id: string;
  email: string;
  displayName: string;
  role: LocalAuthUserRole;
  officeId: string;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    officeId: user.officeId,
    activeOfficeId: user.officeId,
  };
}

function buildInviteEmailContent(input: {
  displayName: string;
  recipientEmail: string;
  loginUrl: string;
  temporaryPassword: string | null;
}): InviteEmailContent {
  const firstName = input.displayName.trim().split(/\s+/)[0] || input.displayName;
  const passwordLine = input.temporaryPassword
    ? `Temporary password: ${input.temporaryPassword}`
    : "Temporary password: Generated when the invite is sent.";

  const steps = [
    `Go to ${input.loginUrl}`,
    "Log in with the credentials above",
    "Change your password immediately when prompted",
  ];

  return {
    recipientEmail: input.recipientEmail,
    loginUrl: input.loginUrl,
    subject: "T Rock CRM — You're Invited",
    html: `
      <p>Hi ${firstName},</p>
      <p>You've been invited to T Rock CRM. Your account is ready to use.</p>
      <p><strong>Your login credentials:</strong></p>
      <p>Email: ${input.recipientEmail}<br />${passwordLine}</p>
      <p><strong>Getting started:</strong></p>
      <ol>
        ${steps.map((step) => `<li>${step.replace(input.loginUrl, `<a href="${input.loginUrl}">${input.loginUrl}</a>`)}</li>`).join("\n        ")}
      </ol>
      <p>If you have any issues logging in, try <a href="https://trockcrm.com">https://trockcrm.com</a> as an alternative entry point.</p>
      <p>Questions? Reach out to Addy at 469-690-2240.</p>
      <p>— T Rock CRM Team</p>
    `,
    text: [
      `Hi ${firstName},`,
      "",
      "You've been invited to T Rock CRM. Your account is ready to use.",
      "",
      "Your login credentials:",
      "",
      `Email: ${input.recipientEmail}`,
      passwordLine,
      "",
      "Getting started:",
      "",
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      "",
      "If you have any issues logging in, try https://trockcrm.com as an alternative entry point.",
      "",
      "Questions? Reach out to Addy at 469-690-2240.",
      "",
      "— T Rock CRM Team",
    ].join("\n"),
  };
}

function inviteLoginUrl(inputUrl?: string): string {
  return inputUrl ?? process.env.ONBOARDING_CLEANUP_URL ?? DEFAULT_CLEANUP_LOGIN_URL;
}

async function recordLocalAuthEvent(input: {
  userId: string;
  eventType:
    | "invite_previewed"
    | "invite_sent"
    | "invite_resent"
    | "invite_revoked"
    | "login_succeeded"
    | "login_failed"
    | "login_locked"
    | "password_changed";
  actorUserId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  await db.insert(userLocalAuthEvents).values({
    userId: input.userId,
    eventType: input.eventType,
    actorUserId: input.actorUserId ?? null,
    metadata: input.metadata ?? null,
  });
}

export function getLocalAuthStatus(input: {
  isEnabled: boolean;
  mustChangePassword: boolean;
  inviteSentAt: Date | null;
  lastLoginAt: Date | null;
  inviteExpiresAt?: Date | null;
  revokedAt?: Date | null;
  lockedUntil?: Date | null;
} | null): LocalAuthStatus {
  if (!input) return "not_invited";
  if (!input.isEnabled) return "disabled";
  if (input.revokedAt) return "disabled";
  if (input.lockedUntil && input.lockedUntil.getTime() > Date.now()) return "disabled";
  if (!input.lastLoginAt && input.inviteSentAt) {
    return "invite_sent";
  }
  if (input.mustChangePassword) return "password_change_required";
  return "active";
}

export async function hashPassword(password: string): Promise<string> {
  validatePasswordPolicy(password);
  const salt = crypto.randomBytes(16);
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const [scheme, saltHex, hashHex] = storedHash.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return crypto.timingSafeEqual(expected, actual);
}

export function generateTemporaryPassword(): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = crypto.randomBytes(TEMP_PASSWORD_LENGTH);
  let password = "";
  for (let index = 0; index < TEMP_PASSWORD_LENGTH; index += 1) {
    password += alphabet[bytes[index]! % alphabet.length];
  }
  return password;
}

export async function getUserLocalAuthGate(userId: string): Promise<{
  mustChangePassword: boolean;
  isEnabled: boolean;
  inviteExpiresAt: Date | null;
  lockedUntil: Date | null;
  revokedAt: Date | null;
}> {
  const [row] = await db
    .select({
      mustChangePassword: userLocalAuth.mustChangePassword,
      isEnabled: userLocalAuth.isEnabled,
      inviteExpiresAt: userLocalAuth.inviteExpiresAt,
      lockedUntil: userLocalAuth.lockedUntil,
      revokedAt: userLocalAuth.revokedAt,
    })
    .from(userLocalAuth)
    .where(eq(userLocalAuth.userId, userId))
    .limit(1);

  return {
    mustChangePassword: Boolean(row?.isEnabled && row?.mustChangePassword),
    isEnabled: Boolean(row?.isEnabled),
    inviteExpiresAt: row?.inviteExpiresAt ?? null,
    lockedUntil: row?.lockedUntil ?? null,
    revokedAt: row?.revokedAt ?? null,
  };
}

export async function previewUserInvite(input: {
  userId: string;
  actorUserId: string;
  loginUrl?: string;
}) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!user) throw new AppError(404, "User not found");
  if (!user.isActive) throw new AppError(400, "Cannot preview an invite for an inactive user");
  const loginUrl = inviteLoginUrl(input.loginUrl);
  const preview = buildInviteEmailContent({
    displayName: user.displayName,
    recipientEmail: user.email,
    loginUrl,
    temporaryPassword: null,
  });

  await recordLocalAuthEvent({
    userId: user.id,
    actorUserId: input.actorUserId,
    eventType: "invite_previewed",
  });

  return preview;
}

export async function sendUserInvite(input: {
  userId: string;
  sentByUserId: string;
  loginUrl?: string;
}) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!user) throw new AppError(404, "User not found");
  if (!user.isActive) throw new AppError(400, "Cannot invite an inactive user");

  const existingGate = await getUserLocalAuthGate(user.id);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const currentTime = now();
  const inviteExpiresAt = computeInviteExpiry(currentTime);

  await db
    .insert(userLocalAuth)
    .values({
      userId: user.id,
      passwordHash,
      mustChangePassword: true,
      isEnabled: true,
      inviteSentAt: currentTime,
      inviteSentByUserId: input.sentByUserId,
      inviteExpiresAt,
      lastLoginAt: null,
      failedLoginAttempts: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      passwordChangedAt: null,
      revokedAt: null,
      revokedByUserId: null,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: userLocalAuth.userId,
      set: {
        passwordHash,
        mustChangePassword: true,
        isEnabled: true,
        inviteSentAt: currentTime,
        inviteSentByUserId: input.sentByUserId,
        inviteExpiresAt,
        lastLoginAt: null,
        failedLoginAttempts: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
        passwordChangedAt: null,
        revokedAt: null,
        revokedByUserId: null,
        updatedAt: currentTime,
      },
    });

  const loginUrl = inviteLoginUrl(input.loginUrl);
  const emailContent = buildInviteEmailContent({
    displayName: user.displayName,
    recipientEmail: user.email,
    loginUrl,
    temporaryPassword,
  });
  const emailSent = await sendSystemEmail(
    user.email,
    emailContent.subject,
    emailContent.html,
    { text: emailContent.text },
  );

  if (!emailSent) {
    throw new AppError(500, "Failed to send invite email");
  }

  await recordLocalAuthEvent({
    userId: user.id,
    actorUserId: input.sentByUserId,
    eventType: existingGate.isEnabled ? "invite_resent" : "invite_sent",
    metadata: { inviteExpiresAt: inviteExpiresAt.toISOString() },
  });

  return {
    success: true,
    inviteExpiresAt,
  };
}

/**
 * Injectable seams for {@link restartCorrectiveActionCyclesForRevokedFieldLogin} — the office enumeration, the
 * per-office transaction runner, and the restart itself are dependencies so the cross-office fan-out (which
 * needs the real pooled connection + search_path envelope) can be exercised against a single PGlite instance
 * in a runtime test. Defaults resolve to the real cross-office helpers.
 */
export interface RevokeRestartDeps {
  listOffices: () => Promise<FieldOffice[]>;
  runInOffice: (office: FieldOffice, run: (officeDb: FieldTenantDb) => Promise<void>) => Promise<void>;
  restartCycleForDeal: (
    officeDb: FieldTenantDb,
    input: { dealId: string; office: FieldOffice },
  ) => Promise<void>;
}

function defaultRevokeRestartDeps(actorUserId: string): RevokeRestartDeps {
  return {
    listOffices: listActiveFieldOffices,
    // Bind the per-office transaction to the ACTOR (the admin who revoked) so app.current_user_id / audit
    // stamps a real user, mirroring the tenantMiddleware envelope every other corrective-action restart runs in.
    runInOffice: (office, run) => runInOfficeTransaction(office, actorUserId, (officeDb) => run(officeDb)),
    restartCycleForDeal: restartCorrectiveActionNotificationCycleForDeal,
  };
}

/**
 * When a user's FIELD-LOGIN capability is revoked (user_local_auth.is_enabled → false) while the user AND their
 * deal-team assignment stay ACTIVE, a CRM super/PM responder can no longer open the trockcam:// deep link they
 * were emailed — and, absent any team mutation, NOTHING restarts the notification cycle, so they never receive
 * the tokenized web fallback. They are stranded: dead deep link, no working link, sent stamp still set.
 *
 * This restarts the OPEN corrective-action notification cycle for every deal on which the revoked user is an
 * ACTIVE superintendent/project_manager, across ALL active offices (the user may be assigned in more than one).
 * The worker's per-recipient routing re-resolves each recipient's field-login capability at send time
 * (is_enabled = TRUE AND revoked_at IS NULL), so on the restarted cycle the now-revoked user correctly gets the
 * tokenized web link instead of the deep link.
 *
 * Best-effort and NON-blocking: it runs AFTER the revoke has committed and any office failing is captured, not
 * propagated (Promise.allSettled) — a re-notify hiccup must never fail the revoke itself. Idempotent per office
 * because {@link restartCorrectiveActionNotificationCycleForDeal} is (fresh nonce, sent-stamp clear, one job).
 */
export async function restartCorrectiveActionCyclesForRevokedFieldLogin(
  userId: string,
  deps: RevokeRestartDeps,
): Promise<void> {
  const offices = await deps.listOffices();
  await Promise.allSettled(
    offices.map((office) =>
      deps.runInOffice(office, async (officeDb) => {
        // Deals in THIS office where the revoked user is an ACTIVE super/PM assignment. DISTINCT because a user
        // could hold both responder roles on the same deal (one restart covers all its open cards regardless).
        const rows = await officeDb
          .selectDistinct({ dealId: dealTeamMembers.dealId })
          .from(dealTeamMembers)
          .where(
            and(
              eq(dealTeamMembers.userId, userId),
              eq(dealTeamMembers.isActive, true),
              sql`${dealTeamMembers.role} IN ('superintendent', 'project_manager')`,
            ),
          );
        for (const { dealId } of rows) {
          await deps.restartCycleForDeal(officeDb, { dealId, office });
        }
      }),
    ),
  );
}

export async function revokeUserInvite(
  input: {
    userId: string;
    actorUserId: string;
  },
  restartDeps?: RevokeRestartDeps,
) {
  const [existing] = await db
    .select({ userId: userLocalAuth.userId })
    .from(userLocalAuth)
    .where(eq(userLocalAuth.userId, input.userId))
    .limit(1);

  if (!existing) {
    throw new AppError(404, "Local login is not enabled for this user");
  }

  const currentTime = now();

  await db
    .update(userLocalAuth)
    .set({
      isEnabled: false,
      mustChangePassword: false,
      inviteExpiresAt: null,
      failedLoginAttempts: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      revokedAt: currentTime,
      revokedByUserId: input.actorUserId,
      updatedAt: currentTime,
    })
    .where(eq(userLocalAuth.userId, input.userId));

  await recordLocalAuthEvent({
    userId: input.userId,
    actorUserId: input.actorUserId,
    eventType: "invite_revoked",
  });

  // The field-login capability is now revoked. Any deal where this user is an active superintendent/
  // project_manager may have an OPEN corrective action whose notification already stamped as sent with a
  // trockcam:// deep link the user can no longer open — and no team mutation will restart it. Restart those
  // deals' cycles so the worker re-resolves the (now field-login-less) user to the tokenized web fallback.
  // Runs AFTER the is_enabled=false write has committed so the worker's per-recipient re-resolve sees the
  // revoked state. Best-effort and non-blocking: a re-notify failure must never fail the revoke itself.
  try {
    await restartCorrectiveActionCyclesForRevokedFieldLogin(
      input.userId,
      restartDeps ?? defaultRevokeRestartDeps(input.actorUserId),
    );
  } catch (err) {
    console.error("[local-auth] corrective-action re-notify after revoke failed", {
      userId: input.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function listLocalAuthEvents(userId: string) {
  return db
    .select({
      id: userLocalAuthEvents.id,
      eventType: userLocalAuthEvents.eventType,
      actorUserId: userLocalAuthEvents.actorUserId,
      metadata: userLocalAuthEvents.metadata,
      createdAt: userLocalAuthEvents.createdAt,
    })
    .from(userLocalAuthEvents)
    .where(eq(userLocalAuthEvents.userId, userId));
}

export async function loginWithLocalPassword(input: {
  email: string;
  password: string;
}) {
  const normalizedEmail = normalizeEmail(input.email);
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      officeId: users.officeId,
      isActive: users.isActive,
      tokenVersion: users.tokenVersion,
      passwordHash: userLocalAuth.passwordHash,
      mustChangePassword: userLocalAuth.mustChangePassword,
      isEnabled: userLocalAuth.isEnabled,
      inviteExpiresAt: userLocalAuth.inviteExpiresAt,
      lastLoginAt: userLocalAuth.lastLoginAt,
      failedLoginAttempts: userLocalAuth.failedLoginAttempts,
      lockedUntil: userLocalAuth.lockedUntil,
    })
    .from(users)
    .innerJoin(userLocalAuth, eq(userLocalAuth.userId, users.id))
    .where(and(eq(users.email, normalizedEmail), eq(userLocalAuth.isEnabled, true)))
    .limit(1);

  if (!row || !row.isActive) {
    throw new AppError(401, "Invalid email or password");
  }
  assertLocalAuthUserRole(row.role);

  const currentTime = now();
  if (row.lockedUntil && row.lockedUntil.getTime() > currentTime.getTime()) {
    throw new AppError(423, "Local login is temporarily locked");
  }

  // A prior lockout whose 15-minute window has now elapsed grants a fresh attempt budget. The stored
  // failed_login_attempts is only ever reset on success/password-change/invite, so without this an
  // unlocked user re-locks on the very next miss (5 + 1 = 6 >= threshold), never getting 5 fresh tries.
  const lockoutExpired =
    row.lockedUntil != null && row.lockedUntil.getTime() <= currentTime.getTime();
  const priorFailedAttempts = lockoutExpired ? 0 : (row.failedLoginAttempts ?? 0);

  const passwordMatches = await verifyPassword(input.password, row.passwordHash);
  if (!passwordMatches) {
    const failedLoginAttempts = priorFailedAttempts + 1;
    const lockedUntil = failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS
      ? computeLockoutUntil(currentTime)
      : null;

    await db
      .update(userLocalAuth)
      .set({
        failedLoginAttempts,
        lastFailedLoginAt: currentTime,
        lockedUntil,
        updatedAt: currentTime,
      })
      .where(eq(userLocalAuth.userId, row.id));

    await recordLocalAuthEvent({
      userId: row.id,
      eventType: "login_failed",
      metadata: { failedLoginAttempts },
    });

    if (lockedUntil) {
      await recordLocalAuthEvent({
        userId: row.id,
        eventType: "login_locked",
        metadata: { lockedUntil: lockedUntil.toISOString() },
      });
      throw new AppError(423, "Local login is temporarily locked");
    }
    throw new AppError(401, "Invalid email or password");
  }

  if (
    !row.lastLoginAt
    && row.inviteExpiresAt
    && row.inviteExpiresAt.getTime() <= currentTime.getTime()
  ) {
    throw new AppError(403, "Temporary invite has expired");
  }

  await db
    .update(userLocalAuth)
    .set({
      lastLoginAt: currentTime,
      failedLoginAttempts: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      updatedAt: currentTime,
    })
    .where(eq(userLocalAuth.userId, row.id));

  await recordLocalAuthEvent({
    userId: row.id,
    eventType: "login_succeeded",
  });

  const localAuthUserRole = row.role;
  return {
    user: {
      ...buildUserPayload({ ...row, role: localAuthUserRole }),
      mustChangePassword: row.mustChangePassword,
    },
    // The mint-time token version, returned separately so it's stamped into the JWT without leaking
    // into the client user payload.
    tokenVersion: row.tokenVersion,
  };
}

export async function changeLocalPassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}) {
  validatePasswordPolicy(input.newPassword);

  const [row] = await db
    .select({
      passwordHash: userLocalAuth.passwordHash,
      isEnabled: userLocalAuth.isEnabled,
    })
    .from(userLocalAuth)
    .where(eq(userLocalAuth.userId, input.userId))
    .limit(1);

  if (!row?.isEnabled) {
    throw new AppError(404, "Local login is not enabled for this user");
  }

  const passwordMatches = await verifyPassword(
    input.currentPassword,
    row.passwordHash
  );
  if (!passwordMatches) {
    throw new AppError(401, "Current password is incorrect");
  }

  const nextHash = await hashPassword(input.newPassword);
  const currentTime = now();

  await db
    .update(userLocalAuth)
    .set({
      passwordHash: nextHash,
      mustChangePassword: false,
      inviteExpiresAt: null,
      failedLoginAttempts: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      passwordChangedAt: currentTime,
      updatedAt: currentTime,
    })
    .where(eq(userLocalAuth.userId, input.userId));

  await recordLocalAuthEvent({
    userId: input.userId,
    eventType: "password_changed",
  });
}
