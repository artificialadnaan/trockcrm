import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies, contacts } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Fast search for contact picker / autocomplete.
 * Searches across first_name, last_name, email, company_name, the LINKED company's real name, and phone.
 * Returns minimal fields for dropdown display; companyName is the RESOLVED name (linked companies.name over
 * the free-text company_name) so a contact linked to a real company is both findable and labeled by that
 * company even when its denormalized company_name is null/stale — matching the contacts list/detail + global
 * search. Read-only picker, so resolving in the returned companyName needs no client change.
 */
export async function searchContacts(
  tenantDb: TenantDb,
  query: string,
  limit = 10
): Promise<Array<{
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyName: string | null;
  category: string;
}>> {
  if (!query || query.trim().length < 2) return [];

  const searchTerm = `%${query.trim()}%`;

  return tenantDb
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      // Resolved: linked company's real name wins over the (often null/stale) free-text company_name.
      companyName: sql<string | null>`coalesce(${companies.name}, ${contacts.companyName})`,
      category: contacts.category,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(
      and(
        eq(contacts.isActive, true),
        sql`(
          ${contacts.firstName} ILIKE ${searchTerm}
          OR ${contacts.lastName} ILIKE ${searchTerm}
          OR (${contacts.firstName} || ' ' || ${contacts.lastName}) ILIKE ${searchTerm}
          OR ${contacts.email} ILIKE ${searchTerm}
          OR ${contacts.companyName} ILIKE ${searchTerm}
          OR ${companies.name} ILIKE ${searchTerm}
          OR ${contacts.phone} ILIKE ${searchTerm}
          OR ${contacts.mobile} ILIKE ${searchTerm}
        )`
      )
    )
    .orderBy(contacts.lastName, contacts.firstName)
    .limit(limit);
}
