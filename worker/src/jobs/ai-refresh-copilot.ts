import { deadJob } from "../queue.js";
import { pool } from "../db.js";

export async function runAiRefreshCopilot(payload: {
  dealId: string;
  reason?: string;
  requestedBy: string;
}, officeId: string | null) {
  if (!payload?.requestedBy) {
    const error = `[Worker:ai-refresh-copilot] Missing requestedBy for dealId=${payload?.dealId ?? "unknown"}`;
    console.error(error);
    return deadJob(error);
  }

  console.log(
    `[Worker:ai-refresh-copilot] Refresh request dealId=${payload.dealId} reason=${payload.reason ?? "unknown"}`
  );

  await pool.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
     VALUES ('ai_generate_deal_copilot', $1, $2, 'pending', NOW())`,
    [
      JSON.stringify({
        dealId: payload.dealId,
        reason: payload.reason ?? "refresh",
        requestedBy: payload.requestedBy,
      }),
      officeId,
    ]
  );
}
