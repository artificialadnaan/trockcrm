import { localAuthEventTypeEnum } from "@trock-crm/shared/schema";
import { describe, expect, it } from "vitest";
import type { LocalAuthEventType } from "../../../src/modules/auth/local-auth-service.js";

/**
 * recordLocalAuthEvent's accepted event types must stay identical to the Postgres enum.
 *
 * The union was hand-maintained and had already drifted -- 'password_change_forced' was legal in the
 * database but a type error at the call site. This guards both directions.
 */

// The annotation documents intent, but it is NOT what enforces this: neither tsconfig.json nor
// tsconfig.typecheck.json actually typechecks this directory, and vitest strips types without checking
// them. Verified by deleting a key and watching `npm run typecheck` stay green. The runtime assertion
// below is the real guard -- verified to fail on the same mutation.
const EVERY_EVENT_TYPE: Record<LocalAuthEventType, true> = {
  invite_previewed: true,
  invite_sent: true,
  invite_resent: true,
  invite_revoked: true,
  login_succeeded: true,
  login_failed: true,
  login_locked: true,
  password_changed: true,
  password_change_forced: true,
  password_reset_requested: true,
  password_reset_completed: true,
};

describe("local auth event types", () => {
  it("covers exactly the Postgres enum, with nothing missing or extra", () => {
    expect(Object.keys(EVERY_EVENT_TYPE).sort()).toEqual([...localAuthEventTypeEnum.enumValues].sort());
  });

  it("includes the two event types the self-service reset flow writes", () => {
    // These already existed in the Postgres enum via migration 0187 but were unreachable from the
    // CRM service, which is why the reset flow needs no enum migration of its own.
    expect(localAuthEventTypeEnum.enumValues).toContain("password_reset_requested");
    expect(localAuthEventTypeEnum.enumValues).toContain("password_reset_completed");
  });
});
