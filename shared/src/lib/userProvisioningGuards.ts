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

// True when a change strips admin-ness from an admin (deactivate or demote) — i.e. when the
// last-active-admin guard must consult the active-admin count. Lets the caller scope the (locking)
// count query to exactly the cases that need it.
export function stripsAdminPrivilege(currentRole: UserRole, nextRole: UserRole | undefined, nextIsActive: boolean | undefined): boolean {
  if (currentRole !== "admin") return false;
  return nextIsActive === false || (nextRole !== undefined && nextRole !== "admin");
}

export interface GuardViolation {
  status: number;
  message: string;
}

// Composes the three update guards in priority order; returns the first violation or null. Pure, so
// the enforcement wiring (which guard fires -> which HTTP status) is gate-executed, not just the
// individual predicates. `otherActiveAdminCount` is only consulted when admin privilege is stripped.
export function evaluateUpdateUserGuards(input: {
  actorId: string;
  targetId: string;
  currentRole: UserRole;
  nextRole?: UserRole;
  nextIsActive?: boolean;
  otherActiveAdminCount: number;
}): GuardViolation | null {
  if (
    isProhibitedSelfChange({
      actorId: input.actorId,
      targetId: input.targetId,
      nextIsActive: input.nextIsActive,
      currentRole: input.currentRole,
      nextRole: input.nextRole,
    })
  ) {
    return { status: 403, message: "You can't deactivate or change your own role" };
  }
  if (isFieldContractorTransition(input.currentRole, input.nextRole)) {
    return { status: 403, message: "Field contractors are managed in the field-user flow" };
  }
  if (
    wouldRemoveLastActiveAdmin({
      currentRole: input.currentRole,
      nextRole: input.nextRole,
      nextIsActive: input.nextIsActive,
      otherActiveAdminCount: input.otherActiveAdminCount,
    })
  ) {
    return { status: 409, message: "Cannot remove the last active admin" };
  }
  return null;
}

export interface SessionInvalidationPlan {
  bumpEpoch: boolean;
  revokeLocalAuth: boolean;
  clearLocalAuthRevocation: boolean;
  closeStreams: boolean;
}

// Decides which session-kill effects a user update triggers. Pure, so the deactivate/reactivate/
// role-change -> effects mapping is gate-executed.
export function planSessionInvalidation(input: {
  currentIsActive: boolean;
  currentRole: UserRole;
  nextIsActive?: boolean;
  nextRole?: UserRole;
}): SessionInvalidationPlan {
  const deactivating = input.nextIsActive === false && input.currentIsActive === true;
  const reactivating = input.nextIsActive === true && input.currentIsActive === false;
  const roleChanged = input.nextRole !== undefined && input.nextRole !== input.currentRole;
  return {
    // Reactivate MUST bump too: a user deactivated before this column existed (or otherwise) has a
    // null epoch, so without a bump their still-unexpired pre-deactivation token (field: 30d) would
    // pass the not-stale-on-null check and revive on reactivation. Bumping forces a fresh login.
    bumpEpoch: deactivating || reactivating || roleChanged,
    revokeLocalAuth: deactivating,
    clearLocalAuthRevocation: reactivating,
    // Role change also tears down the open notifications stream so a demoted/promoted user's stream
    // doesn't keep pushing until it reconnects.
    closeStreams: deactivating || roleChanged,
  };
}
