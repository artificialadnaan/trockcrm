import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Fast search for contact picker / autocomplete.
 * Searches across first_name, last_name, email, company_name, phone.
 * Returns minimal fields for dropdown display.
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
      companyName: contacts.companyName,
      category: contacts.category,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.isActive, true),
        sql`(
          ${contacts.firstName} ILIKE ${searchTerm}
          OR ${contacts.lastName} ILIKE ${searchTerm}
          OR (${contacts.firstName} || ' ' || ${contacts.lastName}) ILIKE ${searchTerm}
          OR ${contacts.email} ILIKE ${searchTerm}
          OR ${contacts.companyName} ILIKE ${searchTerm}
          OR ${contacts.phone} ILIKE ${searchTerm}
          OR ${contacts.mobile} ILIKE ${searchTerm}
        )`
      )
    )
    .orderBy(contacts.lastName, contacts.firstName)
    .limit(limit);
}
