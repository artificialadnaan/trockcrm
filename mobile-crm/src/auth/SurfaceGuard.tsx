import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuth } from "./AuthContext";
import { canAccessSurface, type CrmSurface } from "./surfaces";

/**
 * The role guard every CRM surface group wraps itself in.
 *
 * Shared rather than repeated per group: the deals and contacts layouts were the same four lines apart
 * from one string, and in this codebase every idea written twice has eventually diverged in one copy.
 * A route guard is the worst place for that to happen quietly.
 *
 * Returning null (not a redirect) when signed out is deliberate: the parent (app) layout already owns
 * the login redirect, and a second one racing it produces a navigation loop.
 */
export function SurfaceStack({ surface }: { surface: CrmSurface }) {
  const { session } = useAuth();
  if (!session) return null;
  if (!canAccessSurface(session.user.role, surface)) return <Redirect href="/(app)/dashboard" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
