import { pool } from "../db.js";

export async function runAiIndexDocument(payload: {
  sourceType: string;
  sourceId: string;
  officeId?: string | null;
}): Promise<void> {
  console.log(
    `[Worker:ai-index-document] Index request sourceType=${payload.sourceType} sourceId=${payload.sourceId}`
  );

  // Task 3 only wires the job seam. Full embedding + persistence work lands in later slices.
  await pool.query("SELECT 1");
}
