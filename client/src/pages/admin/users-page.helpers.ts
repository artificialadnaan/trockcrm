import type { AdminUser } from "@/hooks/use-admin-users";

export type UserSourceFilter = "all" | "hubspot" | "procore" | "multi" | "none";
export type UserActivityFilter = "all" | "active" | "inactive";
export type UserRoleFilter = "all" | AdminUser["role"];
export type UserAuthFilter = "all" | AdminUser["localAuthStatus"];

export interface UserFilterState {
  query: string;
  role: UserRoleFilter;
  source: UserSourceFilter;
  activity: UserActivityFilter;
  auth: UserAuthFilter;
}

export function filterUsers(users: AdminUser[], filters: UserFilterState) {
  const query = filters.query.trim().toLowerCase();

  return users.filter((user) => {
    if (query) {
      const haystack = `${user.displayName} ${user.email}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    if (filters.role !== "all" && user.role !== filters.role) return false;
    if (filters.activity === "active" && !user.isActive) return false;
    if (filters.activity === "inactive" && user.isActive) return false;
    if (filters.auth !== "all" && user.localAuthStatus !== filters.auth) return false;

    switch (filters.source) {
      case "hubspot":
        return user.sourceSystems.includes("hubspot");
      case "procore":
        return user.sourceSystems.includes("procore");
      case "multi":
        return user.sourceSystems.length > 1;
      case "none":
        return user.sourceSystems.length === 0;
      default:
        return true;
    }
  });
}

export function buildUsersSummary(users: AdminUser[]) {
  return {
    total: users.length,
    active: users.filter((user) => user.isActive).length,
    inactive: users.filter((user) => !user.isActive).length,
    reps: users.filter((user) => user.role === "rep").length,
    directors: users.filter((user) => user.role === "director").length,
    admins: users.filter((user) => user.role === "admin").length,
    notInvited: users.filter((user) => user.localAuthStatus === "not_invited").length,
  };
}

export function pruneSelection(selectedIds: string[], visibleIds: string[]) {
  return selectedIds.filter((id) => visibleIds.includes(id));
}
