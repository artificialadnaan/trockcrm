import React from "react";
import { SurfaceStack } from "../../../src/auth/SurfaceGuard";

/**
 * Role guard for the lead DETAIL routes, which live above the tab bar so Back keeps the context a rep
 * arrived from — the same split the deals surface uses ((tabs)/deals holds the list, (app)/deals the
 * detail).
 *
 * Guarding here as well as on the tab group is not redundant: these routes are reachable by deep link
 * and from other surfaces, so the tab-group guard never runs for them. A guard that only covers the
 * route you happened to arrive by is not a guard.
 *
 * Uses the shared SurfaceStack rather than repeating its four lines, which is what this file did until
 * it became the third copy of the same guard.
 */
export default function LeadsDetailLayout() {
  return <SurfaceStack surface="leads" />;
}
