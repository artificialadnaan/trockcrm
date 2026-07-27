/**
 * TanStack Query key factory. Every key is scoped by officeId because offices are separate Postgres
 * schemas — the same deal id in two offices is two different records, so an unscoped cache would serve
 * one office's data after switching to another.
 */
export const qk = {
  me: () => ["me"] as const,
  offices: () => ["offices"] as const,
  deals: (officeId: string | null, params?: Record<string, unknown>) =>
    ["deals", officeId, params ?? {}] as const,
  deal: (officeId: string | null, id: string) => ["deal", officeId, id] as const,
  contacts: (officeId: string | null, params?: Record<string, unknown>) =>
    ["contacts", officeId, params ?? {}] as const,
  contact: (officeId: string | null, id: string) => ["contact", officeId, id] as const,
} as const;
