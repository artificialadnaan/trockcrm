/**
 * Roles and read-scopes carried by an MCP session token.
 *
 * The MCP surface is READ-ONLY. "scope" expresses *how much* a session may read:
 *  - `read_all`        — may reach sensitive data (email bodies, named-rep activity).
 *  - `read_restricted` — aggregate / non-sensitive reads only.
 *
 * The role is derived server-side from the user record (by GREEN's mint endpoint),
 * never from request input the model can influence.
 */
export const MCP_ROLES = ["owner", "cfo", "rep", "viewer"] as const;
export type McpRole = (typeof MCP_ROLES)[number];

export const MCP_SCOPES = ["read_all", "read_restricted"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Roles that are allowed to hold the elevated `read_all` scope. */
const PRIVILEGED_ROLES: ReadonlySet<McpRole> = new Set<McpRole>(["owner", "cfo"]);

export function isMcpRole(value: unknown): value is McpRole {
  return typeof value === "string" && (MCP_ROLES as readonly string[]).includes(value);
}

export function isMcpScope(value: unknown): value is McpScope {
  return typeof value === "string" && (MCP_SCOPES as readonly string[]).includes(value);
}

/**
 * Canonical role → default scope mapping. `read_all` only for owner/cfo; everyone
 * else gets `read_restricted`. This is the single source of truth GREEN should use
 * when minting, so the rule lives in exactly one place.
 */
export function scopeForRole(role: McpRole): McpScope {
  return PRIVILEGED_ROLES.has(role) ? "read_all" : "read_restricted";
}

/**
 * Is this (role, scope) pair allowed? `read_all` requires a privileged role;
 * `read_restricted` is always allowed (a privileged role may deliberately
 * down-scope). Used to reject privilege escalation at both mint and validate time.
 */
export function isRoleScopeConsistent(role: McpRole, scope: McpScope): boolean {
  if (scope === "read_all") return PRIVILEGED_ROLES.has(role);
  return true;
}

/** Higher number = strictly more access. */
const SCOPE_RANK: Record<McpScope, number> = {
  read_restricted: 1,
  read_all: 2,
};

/**
 * Does a session holding `held` satisfy a guard requiring `required`?
 * `read_all` satisfies both; `read_restricted` satisfies only `read_restricted`.
 */
export function scopeSatisfies(held: McpScope, required: McpScope): boolean {
  return SCOPE_RANK[held] >= SCOPE_RANK[required];
}
