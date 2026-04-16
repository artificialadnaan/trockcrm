import jwt from "jsonwebtoken";
import { eq, and, like } from "drizzle-orm";
import { db } from "../../db.js";
import { offices, users, userOfficeAccess } from "@trock-crm/shared/schema";
import type { JwtClaims } from "@trock-crm/shared/types";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const nodeEnv = process.env.NODE_ENV;
  const isLocalDevEnv = nodeEnv === "development" || nodeEnv === "test";
  if (!secret && !isLocalDevEnv) {
    throw new Error("JWT_SECRET must be set outside local development/test");
  }
  return secret || "dev-secret-change-in-production";
}

const JWT_EXPIRES_IN = "24h";

export function signJwt(claims: JwtClaims): string {
  return jwt.sign(claims, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

export function verifyJwt(token: string): JwtClaims {
  return jwt.verify(token, getJwtSecret()) as JwtClaims;
}

export async function getUserById(userId: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return result[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return result[0] ?? null;
}

export async function getUserByAzureId(azureAdId: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.azureAdId, azureAdId))
    .limit(1);
  return result[0] ?? null;
}

export async function getDevUsers() {
  const result = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      officeId: users.officeId,
    })
    .from(users)
    .where(and(eq(users.isActive, true), like(users.email, "%@trock.dev")));
  return result;
}

export async function getOfficeBySlug(slug: string) {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;

  const result = await db
    .select()
    .from(offices)
    .where(eq(offices.slug, normalized))
    .limit(1);

  return result[0] ?? null;
}

export async function ensureDevUserPrimaryOffice(userId: string, preferredOfficeSlug = "dallas") {
  const user = await getUserById(userId);
  if (!user || !user.email.endsWith("@trock.dev")) {
    return user;
  }

  const office = await getOfficeBySlug(preferredOfficeSlug);
  if (!office || !office.isActive || user.officeId === office.id) {
    return user;
  }

  const [updatedUser] = await db
    .update(users)
    .set({ officeId: office.id })
    .where(eq(users.id, userId))
    .returning();

  return updatedUser ?? user;
}

export async function canAccessOffice(userId: string, officeId: string): Promise<boolean> {
  const { hasAccess } = await getOfficeAccess(userId, officeId);
  return hasAccess;
}

/**
 * Check office access AND return the role_override if one exists.
 * Primary office always has access with no override.
 */
export async function getOfficeAccess(
  userId: string,
  officeId: string,
): Promise<{ hasAccess: boolean; roleOverride?: string }> {
  const user = await getUserById(userId);
  if (!user) return { hasAccess: false };
  if (user.officeId === officeId) return { hasAccess: true }; // Primary office, no override

  // Check user_office_access for cross-office access + role override
  const rows = await db
    .select()
    .from(userOfficeAccess)
    .where(eq(userOfficeAccess.userId, userId))
    .limit(100);

  const access = rows.find((a) => a.officeId === officeId);
  if (!access) return { hasAccess: false };
  return { hasAccess: true, roleOverride: access.roleOverride || undefined };
}
