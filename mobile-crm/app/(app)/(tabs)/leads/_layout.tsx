import React from "react";
import { SurfaceStack } from "../../../../src/auth/SurfaceGuard";

/**
 * Role guard for the leads TAB, matching the deals and contacts tab groups exactly.
 *
 * The tab's `href` is already filtered by the same policy, but that only hides the button: the route
 * stays reachable by deep link and by restored navigation state, so the guard has to live on the group
 * as well. Enforcement here, courtesy in the tab bar — the arrangement the web sidebar uses too.
 */
export default function LeadsTabLayout() {
  return <SurfaceStack surface="leads" />;
}
