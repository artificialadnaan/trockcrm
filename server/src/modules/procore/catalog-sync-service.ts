import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db.js";
import { procoreClient } from "../../lib/procore-client.js";
import {
  costCatalogCodes,
  costCatalogItemCodes,
  costCatalogItems,
  costCatalogPrices,
  costCatalogSnapshotVersions,
  costCatalogSources,
  costCatalogSyncRuns,
} from "@trock-crm/shared/schema";

interface ProcoreCatalogCodePayload {
  id?: string | number | null;
  code?: string | null;
  name?: string | null;
}

interface ProcoreCatalogItemPayload {
  id?: string | number | null;
  name?: string | null;
  description?: string | null;
  unit_of_measure?: string | null;
  item_type?: string | null;
  catalog_name?: string | null;
  catalog_number?: string | null;
  manufacturer?: string | null;
  supplier?: string | null;
  taxable?: boolean | null;
  unit_cost?: number | string | null;
  labor_unit_cost?: number | string | null;
  material_unit_cost?: number | string | null;
  equipment_unit_cost?: number | string | null;
  subcontract_unit_cost?: number | string | null;
  cost_code?: ProcoreCatalogCodePayload | null;
}

export interface NormalizedCatalogItem {
  item: {
    externalId: string;
    itemType: string;
    name: string;
    description: string | null;
    unit: string | null;
    catalogName: string | null;
    catalogNumber: string | null;
    manufacturer: string | null;
    supplier: string | null;
    taxable: boolean;
  };
  code: {
    externalId: string;
    code: string;
    name: string;
  } | null;
  price: {
    blendedUnitCost: string | null;
    laborUnitCost: string | null;
    materialUnitCost: string | null;
    equipmentUnitCost: string | null;
    subcontractUnitCost: string | null;
  };
}

function normalizeNullableText(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNullableCost(value: unknown): string | null {
  if (value == null || value === "") return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? String(numericValue) : null;
}

export function normalizeCatalogItem(payload: ProcoreCatalogItemPayload): NormalizedCatalogItem {
  const codeValue = normalizeNullableText(payload.cost_code?.code);

  return {
    item: {
      externalId: String(payload.id ?? ""),
      itemType: normalizeNullableText(payload.item_type) ?? "unknown",
      name: normalizeNullableText(payload.name) ?? "Unnamed item",
      description: normalizeNullableText(payload.description),
      unit: normalizeNullableText(payload.unit_of_measure),
      catalogName: normalizeNullableText(payload.catalog_name) ?? "Procore",
      catalogNumber: normalizeNullableText(payload.catalog_number),
      manufacturer: normalizeNullableText(payload.manufacturer),
      supplier: normalizeNullableText(payload.supplier),
      taxable: payload.taxable === true,
    },
    code: codeValue
      ? {
          externalId: String(payload.cost_code?.id ?? codeValue),
          code: codeValue,
          name: normalizeNullableText(payload.cost_code?.name) ?? codeValue,
        }
      : null,
    price: {
      blendedUnitCost: normalizeNullableCost(payload.unit_cost),
      laborUnitCost: normalizeNullableCost(payload.labor_unit_cost),
      materialUnitCost: normalizeNullableCost(payload.material_unit_cost),
      equipmentUnitCost: normalizeNullableCost(payload.equipment_unit_cost),
      subcontractUnitCost: normalizeNullableCost(payload.subcontract_unit_cost),
    },
  };
}

async function ensureProcoreCatalogSource() {
  const [existing] = await db
    .select()
    .from(costCatalogSources)
    .where(eq(costCatalogSources.provider, "procore"))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(costCatalogSources)
    .values({
      provider: "procore",
      externalAccountId: process.env.PROCORE_COMPANY_ID ?? null,
      name: "Procore Cost Catalog",
      status: "active",
    })
    .returning();

  return created;
}

async function fetchProcoreCatalogItems(companyId: string): Promise<ProcoreCatalogItemPayload[]> {
  const rows = await procoreClient.get<unknown>(`/rest/v1.0/companies/${companyId}/cost_catalog/items`);
  return Array.isArray(rows) ? (rows as ProcoreCatalogItemPayload[]) : [];
}

export async function markPriorCatalogSnapshotsSuperseded(sourceId: string) {
  await db
    .update(costCatalogSnapshotVersions)
    .set({ status: "superseded" })
    .where(
      and(
        eq(costCatalogSnapshotVersions.sourceId, sourceId),
        eq(costCatalogSnapshotVersions.status, "active")
      )
    );
}

async function writeCatalogSnapshot(
  sourceId: string,
  syncRunId: string,
  snapshotVersionId: string,
  normalizedItems: NormalizedCatalogItem[]
) {
  const seenItemIds: string[] = [];
  const seenCodeIds: string[] = [];

  for (const normalized of normalizedItems) {
    const [item] = await db
      .insert(costCatalogItems)
      .values({
        sourceId,
        snapshotVersionId,
        externalId: normalized.item.externalId,
        itemType: normalized.item.itemType,
        name: normalized.item.name,
        description: normalized.item.description,
        unit: normalized.item.unit,
        catalogName: normalized.item.catalogName,
        catalogNumber: normalized.item.catalogNumber,
        manufacturer: normalized.item.manufacturer,
        supplier: normalized.item.supplier,
        taxable: normalized.item.taxable,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [costCatalogItems.sourceId, costCatalogItems.externalId],
        set: {
          snapshotVersionId,
          itemType: normalized.item.itemType,
          name: normalized.item.name,
          description: normalized.item.description,
          unit: normalized.item.unit,
          catalogName: normalized.item.catalogName,
          catalogNumber: normalized.item.catalogNumber,
          manufacturer: normalized.item.manufacturer,
          supplier: normalized.item.supplier,
          taxable: normalized.item.taxable,
          isActive: true,
        },
      })
      .returning();

    seenItemIds.push(item.id);

    let codeId: string | null = null;
    if (normalized.code) {
      const [code] = await db
        .insert(costCatalogCodes)
        .values({
          sourceId,
          snapshotVersionId,
          externalId: normalized.code.externalId,
          code: normalized.code.code,
          name: normalized.code.name,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [costCatalogCodes.sourceId, costCatalogCodes.externalId],
          set: {
            snapshotVersionId,
            code: normalized.code.code,
            name: normalized.code.name,
            isActive: true,
          },
        })
        .returning();

      codeId = code.id;
      seenCodeIds.push(code.id);

      await db
        .insert(costCatalogItemCodes)
        .values({
          catalogItemId: item.id,
          catalogCodeId: code.id,
          isPrimary: true,
        })
        .onConflictDoUpdate({
          target: [costCatalogItemCodes.catalogItemId, costCatalogItemCodes.catalogCodeId],
          set: { isPrimary: true },
        });
    }

    await db.insert(costCatalogPrices).values({
      catalogItemId: item.id,
      sourceId,
      syncRunId,
      snapshotVersionId,
      blendedUnitCost: normalized.price.blendedUnitCost,
      laborUnitCost: normalized.price.laborUnitCost,
      materialUnitCost: normalized.price.materialUnitCost,
      equipmentUnitCost: normalized.price.equipmentUnitCost,
      subcontractUnitCost: normalized.price.subcontractUnitCost,
      effectiveAt: new Date(),
    });

    if (!codeId) {
      await db
        .delete(costCatalogItemCodes)
        .where(eq(costCatalogItemCodes.catalogItemId, item.id));
    }
  }

  return {
    itemsSeen: normalizedItems.length,
    itemsUpserted: normalizedItems.length,
    seenItemIds,
    seenCodeIds,
  };
}

async function deactivateStaleCatalogRows(sourceId: string, activeItemIds: string[], activeCodeIds: string[]) {
  if (activeItemIds.length > 0) {
    await db
      .update(costCatalogItems)
      .set({ isActive: false })
      .where(
        and(
          eq(costCatalogItems.sourceId, sourceId),
          sql`${costCatalogItems.id} not in ${sql.join(activeItemIds.map((id) => sql`${id}`), sql`, `)}`
        )
      );
  }

  if (activeCodeIds.length > 0) {
    await db
      .update(costCatalogCodes)
      .set({ isActive: false })
      .where(
        and(
          eq(costCatalogCodes.sourceId, sourceId),
          sql`${costCatalogCodes.id} not in ${sql.join(activeCodeIds.map((id) => sql`${id}`), sql`, `)}`
        )
      );
  }
}

async function promoteCatalogSnapshot(sourceId: string, snapshotVersionId: string) {
  await db
    .update(costCatalogSnapshotVersions)
    .set({
      status: "active",
      promotedAt: new Date(),
    })
    .where(
      and(
        eq(costCatalogSnapshotVersions.sourceId, sourceId),
        eq(costCatalogSnapshotVersions.id, snapshotVersionId)
      )
    );
}

async function markCatalogSyncRunSucceeded(sourceId: string, runId: string, itemsSeen: number, itemsUpserted: number) {
  await db
    .update(costCatalogSyncRuns)
    .set({
      status: "succeeded",
      completedAt: new Date(),
      itemsSeen,
      itemsUpserted,
    })
    .where(eq(costCatalogSyncRuns.id, runId));

  await db
    .update(costCatalogSources)
    .set({
      lastSyncedAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
    })
    .where(eq(costCatalogSources.id, sourceId));
}

async function markCatalogSyncRunFailed(runId: string, message: string) {
  await db
    .update(costCatalogSyncRuns)
    .set({
      status: "failed",
      completedAt: new Date(),
      errorSummary: message,
    })
    .where(eq(costCatalogSyncRuns.id, runId));
}

export async function syncCostCatalog(options: { trigger: "manual" | "scheduled"; triggeredByUserId?: string | null }) {
  const source = await ensureProcoreCatalogSource();
  const [run] = await db
    .insert(costCatalogSyncRuns)
    .values({
      sourceId: source.id,
      status: "running",
      metadataJson: {
        trigger: options.trigger,
        triggeredByUserId: options.triggeredByUserId ?? null,
      },
    })
    .returning();

  try {
    const companyId = process.env.PROCORE_COMPANY_ID;
    if (!companyId && !process.env.PROCORE_CLIENT_ID) {
      throw new Error("PROCORE_COMPANY_ID must be set");
    }

    const payload = companyId ? await fetchProcoreCatalogItems(companyId) : [];
    const normalizedItems = payload.map(normalizeCatalogItem).filter((row) => row.item.externalId.length > 0);

    await markPriorCatalogSnapshotsSuperseded(source.id);

    const [snapshot] = await db
      .insert(costCatalogSnapshotVersions)
      .values({
        sourceId: source.id,
        syncRunId: run.id,
        status: "staged",
      })
      .returning();

    const writeResult = await writeCatalogSnapshot(source.id, run.id, snapshot.id, normalizedItems);
    await deactivateStaleCatalogRows(source.id, writeResult.seenItemIds, writeResult.seenCodeIds);
    await promoteCatalogSnapshot(source.id, snapshot.id);
    await markCatalogSyncRunSucceeded(source.id, run.id, writeResult.itemsSeen, writeResult.itemsUpserted);

    return { ...run, status: "succeeded" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "catalog sync failed";
    await markCatalogSyncRunFailed(run.id, message);
    throw error;
  }
}

export async function startCatalogSync(args: { triggeredByUserId?: string | null } = {}) {
  return syncCostCatalog({
    trigger: "manual",
    triggeredByUserId: args.triggeredByUserId ?? null,
  });
}
