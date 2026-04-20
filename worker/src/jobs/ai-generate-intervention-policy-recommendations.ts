import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { pool } from "../db.js";

const SERVER_INTERVENTION_SERVICE_MODULES = [
  "../../../server/dist/modules/ai-copilot/intervention-service.js",
  "../../../server/src/modules/ai-copilot/intervention-service.js",
] as const;

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;

  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to import intervention service module");
}

export async function runAiGenerateInterventionPolicyRecommendations(payload: {
  officeId: string;
  snapshotId: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const officeResult = await client.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1",
      [payload.officeId]
    );
    const officeSlug = officeResult.rows[0]?.slug;
    if (!officeSlug) {
      throw new Error(`Active office not found for ${payload.officeId}`);
    }

    await client.query("SELECT set_config('search_path', $1, true)", [`office_${officeSlug},public`]);
    const tenantDb = drizzle(client, { schema });
    const module = await importFirstAvailable<{
      generateInterventionPolicyRecommendationsSnapshot: (
        tenantDb: unknown,
        input: { officeId: string; snapshotId: string }
      ) => Promise<unknown>;
    }>(SERVER_INTERVENTION_SERVICE_MODULES);

    await module.generateInterventionPolicyRecommendationsSnapshot(tenantDb, {
      officeId: payload.officeId,
      snapshotId: payload.snapshotId,
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await client
      .query("SELECT slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1", [payload.officeId])
      .then(async (officeResult) => {
        const officeSlug = officeResult.rows[0]?.slug;
        if (!officeSlug) return;
        if (!/^[a-z][a-z0-9_]*$/.test(officeSlug)) return;
        const schemaName = `office_${officeSlug}`;
        await client.query(
          `UPDATE ${schemaName}.ai_policy_recommendation_snapshots
           SET status = 'failed', updated_at = NOW()
           WHERE id = $1 AND status = 'pending'`,
          [payload.snapshotId]
        );
      })
      .catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
