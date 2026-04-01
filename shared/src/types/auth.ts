import type { UserRole } from "./enums.js";

export interface JwtClaims {
  userId: string;
  email: string;
  officeId: string;
  role: UserRole;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  officeId: string;
  activeOfficeId: string; // May differ from officeId if user switched offices
}
