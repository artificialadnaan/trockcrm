import { and, eq, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  costCatalogCodes,
  costCatalogItemCodes,
  costCatalogItems,
  costCatalogPrices,
  costCatalogSnapshotVersions,
} from "@trock-crm/shared/schema";

type AppDb = NodePgDatabase<typeof schema>;

export async function resolveActiveCatalogSnapshotVersionId(appDb: AppDb, sourceId: string) {
  const [snapshot] = await appDb
    .select({ id: costCatalogSnapshotVersions.id })
    .from(costCatalogSnapshotVersions)
    .where(
      and(
        eq(costCatalogSnapshotVersions.sourceId, sourceId),
        eq(costCatalogSnapshotVersions.status, "active")
      )
    )
    .limit(1);

  return snapshot?.id ?? null;
}

export async function listCatalogCandidatesForMatching(
  appDb: AppDb,
  sourceId: string,
  snapshotVersionId: string
) {
  return appDb
    .select({
      id: costCatalogItems.id,
      name: costCatalogItems.name,
      unit: costCatalogItems.unit,
      primaryCode: costCatalogCodes.code,
      catalogBaselinePrice: costCatalogPrices.blendedUnitCost,
    })
    .from(costCatalogItems)
    .leftJoin(costCatalogItemCodes, eq(costCatalogItemCodes.catalogItemId, costCatalogItems.id))
    .leftJoin(costCatalogCodes, eq(costCatalogCodes.id, costCatalogItemCodes.catalogCodeId))
    .leftJoin(costCatalogPrices, eq(costCatalogPrices.catalogItemId, costCatalogItems.id))
    .where(
      and(
        eq(costCatalogItems.sourceId, sourceId),
        eq(costCatalogItems.snapshotVersionId, snapshotVersionId),
        or(isNull(costCatalogItemCodes.id), eq(costCatalogItemCodes.isPrimary, true))
      )
    );
}
