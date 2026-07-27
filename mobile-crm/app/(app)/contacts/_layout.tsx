import React from "react";
import { SurfaceStack } from "../../../src/auth/SurfaceGuard";

/**
 * Role guard for the contacts DETAIL routes, which live above the tab bar so that Back keeps the
 * context a rep arrived from.
 *
 * The web sidebar scopes Contacts to admin/director/rep (client/src/components/layout/sidebar.tsx:68),
 * and nav.test.tsx pins that a `construction` user sees no Contacts entry at all. The SERVER's
 * requireCrmUser admits that role, so the requests SUCCEED — meaning without a guard the app hands a
 * field-only role the office-wide contact directory: phone numbers, emails, notes and linked deals.
 *
 * Guarding here as well as on the tab group is not redundant: these routes are reachable by deep link
 * and from other surfaces, so the tab-group guard never runs for them. A guard that only covers the
 * route you happened to arrive by is not a guard.
 */
export default function ContactsDetailLayout() {
  return <SurfaceStack surface="contacts" />;
}
