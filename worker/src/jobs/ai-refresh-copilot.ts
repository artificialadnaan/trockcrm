import { pool } from "../db.js";

export async function runAiRefreshCopilot(payload: {
  dealId: string;
  reason?: string;
}): Promise<void> {
  console.log(
    `[Worker:ai-refresh-copilot] Refresh request dealId=${payload.dealId} reason=${payload.reason ?? "unknown"}`
  );

  await pool.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
     VALUES ('ai_generate_deal_copilot', $1, NULL, 'pending', NOW())`,
    [
      JSON.stringify({
        dealId: payload.dealId,
        reason: payload.reason ?? "refresh",
      }),
    ]
  );
}
