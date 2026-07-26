import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuth } from "../../../src/auth/AuthContext";
import { canAccessSurface } from "../../../src/auth/surfaces";

/**
 * Role guard for the whole deals group.
 *
 * The web sidebar scopes Deals to admin/director/rep (client/src/components/layout/sidebar.tsx:65), but
 * the SERVER's requireCrmUser admits `construction` too — so these requests succeed and the boundary is
 * client-side on both surfaces. Guarding the GROUP rather than each screen means a deep link straight to
 * /(app)/deals/<id> is covered as well; a guard on the list only would be trivially routed around.
 */
export default function DealsLayout() {
  const { session } = useAuth();
  if (!session) return null;
  if (!canAccessSurface(session.user.role, "deals")) return <Redirect href="/(app)/dashboard" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
