import React from "react";
import { SurfaceStack } from "../../../src/auth/SurfaceGuard";

/**
 * Role guard for the companies routes.
 *
 * A bare `Stack` here was an authorisation HOLE, not a stylistic difference: `/companies` is mounted
 * behind `requireCrmUser`, which admits the `construction` role, so the server does not close it
 * either. A session that cannot access this surface could still reach the list and the detail by deep
 * link or by restored navigation state. Every other group in this app uses SurfaceStack; these two
 * were new and skipped it.
 */
export default function CompaniesLayout() {
  return <SurfaceStack surface="companies" />;
}
