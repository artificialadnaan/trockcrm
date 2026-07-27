/**
 * TanStack Query key factory.
 *
 * Every key is scoped by a SCOPE STRING of "userId:officeId:role" — see useQueryScope, which is the
 * only sanctioned way to build one. Three parts, three independent reasons:
 *   - offices are separate Postgres schemas, so the same id in two offices is two different records;
 *   - a second account signing in on the same device would otherwise be served the FIRST account's
 *     cached rows with no request at all, including owner-scoped "mine" results and viewer-filtered
 *     detail (the QueryClient is module-level; it is now also cleared on identity change, but the key
 *     must not depend on that); and
 *   - at-risk is computed against the VIEWER'S ROLE and the thresholds differ materially (a rep gets 7
 *     days on an opportunity where leadership gets 30), so a promotion or a per-office role_override
 *     changes the correct answer without changing the user or the office.
 */
declare const scopeBrand: unique symbol;

/**
 * BRANDED so a plain string cannot be passed by mistake. Every key factory below takes (scope, id) in
 * that order, and both are strings — `qk.deal(dealId, scope)` would compile and silently produce a key
 * that is stable, wrong, and shared by every user. The brand makes that a type error.
 */
export type QueryScope = string & { readonly [scopeBrand]: true };

export const qk = {
  me: () => ["me"] as const,
  offices: () => ["offices"] as const,
  deals: (scope: QueryScope, params?: Record<string, unknown>) =>
    ["deals", scope, params ?? {}] as const,
  deal: (scope: QueryScope, id: string) => ["deal", scope, id] as const,
  contacts: (scope: QueryScope, params?: Record<string, unknown>) =>
    ["contacts", scope, params ?? {}] as const,
  contact: (scope: QueryScope, id: string) => ["contact", scope, id] as const,
  stages: (scope: QueryScope) => ["stages", scope] as const,
  dealActivities: (scope: QueryScope, dealId: string) =>
    ["deal-activities", scope, dealId] as const,
} as const;
