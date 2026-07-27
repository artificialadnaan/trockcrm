import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuth } from "../../../src/auth/AuthContext";
import { canAccessSurface } from "../../../src/auth/surfaces";

/**
 * Role guard for the whole leads group.
 *
 * Same shape as the deals and contacts guards, and for the same reason: the web sidebar scopes Leads to
 * admin/director/rep (client/src/components/layout/sidebar.tsx:66) while the SERVER's requireCrmUser
 * admits `construction` too, so these requests succeed and the boundary is client-side on both surfaces.
 *
 * Guarding the GROUP rather than each screen covers a deep link straight to /(app)/leads/<id>; a guard
 * on the list alone would be trivially routed around.
 */
export default function LeadsLayout() {
  const { session } = useAuth();
  if (!session) return null;
  if (!canAccessSurface(session.user.role, "leads")) return <Redirect href="/(app)/dashboard" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
