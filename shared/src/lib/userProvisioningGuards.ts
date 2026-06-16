import type { UserRole } from "../types/enums.js";

// True when a JWT (issued-at, seconds) predates the user's session epoch (ms). Strict <, so a token
// minted at the same second as the epoch survives. null epoch or unknown iat => not stale.
export function isTokenStaleByEpoch(iatSeconds: number | undefined, tokensValidAfterMs: number | null): boolean {
  if (tokensValidAfterMs == null || iatSeconds == null) return false;
  return iatSeconds * 1000 < tokensValidAfterMs;
}

// An admin may not deactivate themselves or change their own role (anti-lockout / anti-footgun).
export function isProhibitedSelfChange(args: {
  actorId: string;
  targetId: string;
  nextIsActive?: boolean;
  currentRole: UserRole;
  nextRole?: UserRole;
}): boolean {
  if (args.actorId !== args.targetId) return false;
  const deactivatingSelf = args.nextIsActive === false;
  const changingOwnRole = args.nextRole !== undefined && args.nextRole !== args.currentRole;
  return deactivatingSelf || changingOwnRole;
}

// field_contractor has its own lifecycle; block CRM-admin role edits that cross that boundary either way.
export function isFieldContractorTransition(currentRole: UserRole, nextRole: UserRole | undefined): boolean {
  if (nextRole === undefined) return false;
  if (nextRole === "field_contractor") return true;
  // nextRole is a CRM role here; flag leaving field_contractor for it.
  return currentRole === "field_contractor";
}

// True when the change strips admin-ness from an admin and no other active admin remains.
export function wouldRemoveLastActiveAdmin(args: {
  currentRole: UserRole;
  nextRole?: UserRole;
  nextIsActive?: boolean;
  otherActiveAdminCount: number;
}): boolean {
  if (args.currentRole !== "admin") return false;
  const beingDeactivated = args.nextIsActive === false;
  const beingDemoted = args.nextRole !== undefined && args.nextRole !== "admin";
  if (!beingDeactivated && !beingDemoted) return false;
  return args.otherActiveAdminCount === 0;
}
