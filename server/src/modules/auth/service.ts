import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { users, userOfficeAccess } from "@trock-crm/shared/schema";
import type { JwtClaims } from "@trock-crm/shared/types";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production" && !secret) {
    throw new Error("JWT_SECRET must be set in production");
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
    .where(eq(users.isActive, true));
  return result;
}

export async function canAccessOffice(userId: string, officeId: string): Promise<boolean> {
  // Check if it's the user's primary office
  const user = await getUserById(userId);
  if (!user) return false;
  if (user.officeId === officeId) return true;

  // Check user_office_access
  const access = await db
    .select()
    .from(userOfficeAccess)
    .where(eq(userOfficeAccess.userId, userId))
    .limit(100);

  return access.some((a) => a.officeId === officeId);
}
