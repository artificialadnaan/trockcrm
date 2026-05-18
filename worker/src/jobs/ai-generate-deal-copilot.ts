import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { pool } from "../db.js";
import { deadJob } from "../queue.js";

const SERVER_AI_COPILOT_SERVICE_MODULES = [
  "../../../server/dist/modules/ai-copilot/service.js",
  "../../../server/src/modules/ai-copilot/service.js",
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

  throw lastError instanceof Error ? lastError : new Error("Unable to import server AI copilot module");
}

export async function runAiGenerateDealCopilot(payload: {
  dealId: string;
  reason?: string;
  requestedBy: string;
}, officeId: string | null) {
  if (!payload?.requestedBy) {
    const error = `[Worker:ai-generate-deal-copilot] Missing requestedBy for dealId=${payload?.dealId ?? "unknown"}`;
    console.error(error);
    return deadJob(error);
  }

  console.log(
    `[Worker:ai-generate-deal-copilot] Generate request dealId=${payload.dealId} reason=${payload.reason ?? "manual"}`
  );

  if (!officeId) {
    throw new Error("ai_generate_deal_copilot requires officeId");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const officeResult = await client.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1",
      [officeId]
    );
    const officeSlug = officeResult.rows[0]?.slug;
    if (!officeSlug) {
      throw new Error(`Active office not found for ${officeId}`);
    }

    await client.query("SELECT set_config('search_path', $1, true)", [`office_${officeSlug},public`]);
    const tenantDb = drizzle(client, { schema });
    const module = await importFirstAvailable<{
      generateDealCopilotPacket: (
        tenantDb: unknown,
        input: { dealId: string; forceRegenerate?: boolean; viewerUserId: string }
      ) => Promise<unknown>;
    }>(SERVER_AI_COPILOT_SERVICE_MODULES);
    const generateDealCopilotPacket = module.generateDealCopilotPacket as (
      tenantDb: unknown,
      input: { dealId: string; forceRegenerate?: boolean; viewerUserId: string }
    ) => Promise<unknown>;

    await generateDealCopilotPacket(tenantDb, {
      dealId: payload.dealId,
      forceRegenerate: true,
      viewerUserId: payload.requestedBy,
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
