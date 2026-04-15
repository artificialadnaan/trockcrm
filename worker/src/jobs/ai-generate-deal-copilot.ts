import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { pool } from "../db.js";

const SERVER_AI_COPILOT_SERVICE_MODULE = "../../../server/src/modules/ai-copilot/service.js" as string;

export async function runAiGenerateDealCopilot(payload: {
  dealId: string;
  reason?: string;
}, officeId: string | null): Promise<void> {
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
    const module = await import(SERVER_AI_COPILOT_SERVICE_MODULE);
    const generateDealCopilotPacket = module.generateDealCopilotPacket as (
      tenantDb: unknown,
      input: { dealId: string; forceRegenerate?: boolean }
    ) => Promise<unknown>;

    await generateDealCopilotPacket(tenantDb, {
      dealId: payload.dealId,
      forceRegenerate: true,
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
