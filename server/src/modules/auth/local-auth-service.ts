import crypto from "crypto";
import { promisify } from "util";
import { and, eq } from "drizzle-orm";
import { userLocalAuth, userLocalAuthEvents, users } from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { sendSystemEmail } from "../../lib/resend-client.js";

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_MIN_LENGTH = 12;
const TEMP_PASSWORD_LENGTH = 18;
const INVITE_TTL_HOURS = 72;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MINUTES = 15;

export type LocalAuthStatus =
  | "not_invited"
  | "invite_sent"
  | "password_change_required"
  | "active"
  | "disabled";

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
  role: "admin" | "director" | "rep";
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
  const passwordLine = input.temporaryPassword
    ? `<p><strong>Temporary password:</strong> ${input.temporaryPassword}</p>`
    : `<p><strong>Temporary password:</strong> Generated when the invite is sent.</p>`;

  const passwordText = input.temporaryPassword
    ? `Temporary password: ${input.temporaryPassword}`
    : "Temporary password: Generated when the invite is sent.";

  return {
    recipientEmail: input.recipientEmail,
    loginUrl: input.loginUrl,
    subject: "Your T Rock CRM login",
    html: `
      <p>Hi ${input.displayName},</p>
      <p>Your temporary T Rock CRM login is ready.</p>
      <p><strong>Email:</strong> ${input.recipientEmail}</p>
      ${passwordLine}
      <p>Log in at <a href="${input.loginUrl}">${input.loginUrl}</a>. You will be prompted to change your password immediately.</p>
    `,
    text: [
      `Hi ${input.displayName},`,
      "",
      "Your temporary T Rock CRM login is ready.",
      `Email: ${input.recipientEmail}`,
      passwordText,
      `Log in at ${input.loginUrl}. You will be prompted to change your password immediately.`,
    ].join("\n"),
  };
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
  if (input.mustChangePassword && !input.lastLoginAt && input.inviteSentAt) {
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
  const loginUrl = input.loginUrl ?? process.env.FRONTEND_URL ?? "http://localhost:5173";
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

  const loginUrl = input.loginUrl ?? process.env.FRONTEND_URL ?? "http://localhost:5173";
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

export async function revokeUserInvite(input: {
  userId: string;
  actorUserId: string;
}) {
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
      passwordHash: userLocalAuth.passwordHash,
      mustChangePassword: userLocalAuth.mustChangePassword,
      isEnabled: userLocalAuth.isEnabled,
      inviteExpiresAt: userLocalAuth.inviteExpiresAt,
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

  const currentTime = now();
  if (row.lockedUntil && row.lockedUntil.getTime() > currentTime.getTime()) {
    throw new AppError(423, "Local login is temporarily locked");
  }

  const passwordMatches = await verifyPassword(input.password, row.passwordHash);
  if (!passwordMatches) {
    const failedLoginAttempts = (row.failedLoginAttempts ?? 0) + 1;
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
    row.mustChangePassword
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

  return {
    user: {
      ...buildUserPayload(row),
      mustChangePassword: row.mustChangePassword,
    },
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
