import {
  aiDisconnectCaseHistory,
  aiDisconnectCases,
} from "@trock-crm/shared/schema";

interface DisconnectCaseTenantDb {
  select: () => {
    from: <T>(table: T) => Promise<T>;
  };
}

export async function loadDisconnectCaseSchemaTables(
  tenantDb: DisconnectCaseTenantDb
) {
  const cases = await tenantDb.select().from(aiDisconnectCases);
  const history = await tenantDb.select().from(aiDisconnectCaseHistory);

  return { cases, history };
}
