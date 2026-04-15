import { pool } from "../db.js";

export async function runAiGenerateDealCopilot(payload: {
  dealId: string;
  reason?: string;
}): Promise<void> {
  console.log(
    `[Worker:ai-generate-deal-copilot] Generate request dealId=${payload.dealId} reason=${payload.reason ?? "manual"}`
  );

  // Full packet generation wiring lands in the next slice.
  await pool.query("SELECT 1");
}
