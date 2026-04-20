import crypto from "crypto";
import { promisify } from "util";
import { and, eq } from "drizzle-orm";
import { userLocalAuth, users } from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { sendSystemEmail } from "../../lib/resend-client.js";

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_MIN_LENGTH = 12;
const TEMP_PASSWORD_LENGTH = 18;

export type LocalAuthStatus =
  | "not_invited"
  | "invite_sent"
  | "password_change_required"
  | "active"
  | "disabled";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validatePasswordPolicy(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      400,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
    );
  }
}

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

export function getLocalAuthStatus(input: {
  isEnabled: boolean;
  mustChangePassword: boolean;
  inviteSentAt: Date | null;
  lastLoginAt: Date | null;
} | null): LocalAuthStatus {
  if (!input) return "not_invited";
  if (!input.isEnabled) return "disabled";
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
}> {
  const [row] = await db
    .select({
      mustChangePassword: userLocalAuth.mustChangePassword,
      isEnabled: userLocalAuth.isEnabled,
    })
    .from(userLocalAuth)
    .where(eq(userLocalAuth.userId, userId))
    .limit(1);

  return {
    mustChangePassword: Boolean(row?.isEnabled && row?.mustChangePassword),
  };
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

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const now = new Date();

  await db
    .insert(userLocalAuth)
    .values({
      userId: user.id,
      passwordHash,
      mustChangePassword: true,
      isEnabled: true,
      inviteSentAt: now,
      inviteSentByUserId: input.sentByUserId,
      lastLoginAt: null,
      passwordChangedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userLocalAuth.userId,
      set: {
        passwordHash,
        mustChangePassword: true,
        isEnabled: true,
        inviteSentAt: now,
        inviteSentByUserId: input.sentByUserId,
        lastLoginAt: null,
        passwordChangedAt: null,
        updatedAt: now,
      },
    });

  const loginUrl = input.loginUrl ?? process.env.FRONTEND_URL ?? "http://localhost:5173";
  const emailSent = await sendSystemEmail(
    user.email,
    "Your T Rock CRM login",
    `
      <p>Hi ${user.displayName},</p>
      <p>Your temporary T Rock CRM login is ready.</p>
      <p><strong>Email:</strong> ${user.email}</p>
      <p><strong>Temporary password:</strong> ${temporaryPassword}</p>
      <p>Log in at <a href="${loginUrl}">${loginUrl}</a>. You will be prompted to change your password immediately.</p>
    `
  );

  if (!emailSent) {
    throw new AppError(500, "Failed to send invite email");
  }
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
    })
    .from(users)
    .innerJoin(userLocalAuth, eq(userLocalAuth.userId, users.id))
    .where(and(eq(users.email, normalizedEmail), eq(userLocalAuth.isEnabled, true)))
    .limit(1);

  if (!row || !row.isActive) {
    throw new AppError(401, "Invalid email or password");
  }

  const passwordMatches = await verifyPassword(input.password, row.passwordHash);
  if (!passwordMatches) {
    throw new AppError(401, "Invalid email or password");
  }

  await db
    .update(userLocalAuth)
    .set({
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(userLocalAuth.userId, row.id));

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
  const now = new Date();

  await db
    .update(userLocalAuth)
    .set({
      passwordHash: nextHash,
      mustChangePassword: false,
      passwordChangedAt: now,
      updatedAt: now,
    })
    .where(eq(userLocalAuth.userId, input.userId));
}
