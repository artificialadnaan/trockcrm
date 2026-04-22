import { describe, expect, it } from "vitest";
import type { AdminUser } from "@/hooks/use-admin-users";
import {
  buildUsersSummary,
  filterUsers,
  pruneSelection,
  type UserFilterState,
} from "./users-page.helpers";

const users: AdminUser[] = [
  {
    id: "1",
    email: "alice@trockgc.com",
    displayName: "Alice Admin",
    role: "admin",
    officeId: "office-1",
    officeName: "Dallas",
    isActive: true,
    extraOfficeCount: 0,
    sourceSystems: ["hubspot", "procore"],
    localAuthStatus: "not_invited",
    inviteSentAt: null,
    inviteExpiresAt: null,
    lastLoginAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    passwordChangedAt: null,
    revokedAt: null,
    latestLocalAuthEvent: null,
  },
  {
    id: "2",
    email: "derek@trockgc.com",
    displayName: "Derek Director",
    role: "director",
    officeId: "office-1",
    officeName: "Dallas",
    isActive: true,
    extraOfficeCount: 1,
    sourceSystems: ["hubspot"],
    localAuthStatus: "invite_sent",
    inviteSentAt: "2026-04-20T10:00:00.000Z",
    inviteExpiresAt: "2026-04-23T10:00:00.000Z",
    lastLoginAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    passwordChangedAt: null,
    revokedAt: null,
    latestLocalAuthEvent: {
      eventType: "invite_sent",
      actorUserId: "1",
      createdAt: "2026-04-20T10:00:00.000Z",
    },
  },
  {
    id: "3",
    email: "riley@trockgc.com",
    displayName: "Riley Rep",
    role: "rep",
    officeId: "office-1",
    officeName: "Dallas",
    isActive: false,
    extraOfficeCount: 0,
    sourceSystems: ["procore"],
    localAuthStatus: "disabled",
    inviteSentAt: "2026-04-18T10:00:00.000Z",
    inviteExpiresAt: null,
    lastLoginAt: "2026-04-19T10:00:00.000Z",
    failedLoginAttempts: 2,
    lockedUntil: null,
    passwordChangedAt: "2026-04-19T10:00:00.000Z",
    revokedAt: "2026-04-20T09:00:00.000Z",
    latestLocalAuthEvent: {
      eventType: "invite_revoked",
      actorUserId: null,
      createdAt: "2026-04-20T09:00:00.000Z",
    },
  },
];

function makeFilters(overrides: Partial<UserFilterState> = {}): UserFilterState {
  return {
    query: "",
    role: "all",
    source: "all",
    activity: "all",
    auth: "all",
    ...overrides,
  };
}

describe("users-page helpers", () => {
  it("filters by search query across display name and email", () => {
    expect(filterUsers(users, makeFilters({ query: "riley" })).map((user) => user.id)).toEqual(["3"]);
    expect(filterUsers(users, makeFilters({ query: "derek@trock" })).map((user) => user.id)).toEqual(["2"]);
  });

  it("filters by role, activity, source, and auth state", () => {
    expect(filterUsers(users, makeFilters({ role: "admin" })).map((user) => user.id)).toEqual(["1"]);
    expect(filterUsers(users, makeFilters({ activity: "inactive" })).map((user) => user.id)).toEqual(["3"]);
    expect(filterUsers(users, makeFilters({ source: "multi" })).map((user) => user.id)).toEqual(["1"]);
    expect(filterUsers(users, makeFilters({ auth: "invite_sent" })).map((user) => user.id)).toEqual(["2"]);
  });

  it("builds summary counts for the current user set", () => {
    expect(buildUsersSummary(users)).toEqual({
      total: 3,
      active: 2,
      inactive: 1,
      reps: 1,
      directors: 1,
      admins: 1,
      notInvited: 1,
    });
  });

  it("prunes selections down to the visible user set", () => {
    expect(pruneSelection(["1", "2", "3"], ["1", "3"])).toEqual(["1", "3"]);
  });
});
