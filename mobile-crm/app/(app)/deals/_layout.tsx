import React from "react";
import { SurfaceStack } from "../../../src/auth/SurfaceGuard";

/**
 * Role guard for the deals DETAIL routes, which live above the tab bar so that Back keeps the
 * context a rep arrived from.
 *
 * Guarding here as well as on the tab group is not redundant: these routes are reachable by deep link
 * and from other surfaces, so the tab-group guard never runs for them. A guard that only covers the
 * route you happened to arrive by is not a guard.
 */
export default function DealsDetailLayout() {
  return <SurfaceStack surface="deals" />;
}
