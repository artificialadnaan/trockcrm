import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuth } from "../../../src/auth/AuthContext";
import { canAccessSurface } from "../../../src/auth/surfaces";

/**
 * Role guard for the whole contacts group.
 *
 * The web sidebar scopes Contacts to admin/director/rep (client/src/components/layout/sidebar.tsx:68),
 * and nav.test.tsx pins that a `construction` user sees no Contacts entry at all. The SERVER's
 * requireCrmUser admits that role, so the requests succeed — meaning without this guard the app handed a
 * field-only role the office-wide contact directory: phone numbers, emails, notes and linked deals.
 *
 * Guards the GROUP, so a deep link straight to /(app)/contacts/<id> is covered as well.
 */
export default function ContactsLayout() {
  const { session } = useAuth();
  if (!session) return null;
  if (!canAccessSurface(session.user.role, "contacts")) return <Redirect href="/(app)/dashboard" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
