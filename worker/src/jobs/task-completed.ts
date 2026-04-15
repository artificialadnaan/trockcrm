export async function handleTaskCompletedEvent(payload: any, officeId: string | null): Promise<void> {
  console.log(`[Worker] task.completed: ${payload.taskId} — ${payload.title}`);

  if (!payload.completedBy) return;
  if (!officeId) return;

  const { pool: workerPool } = await import("../db.js");
  const officeResult = await workerPool.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [officeId]
  );
  if (officeResult.rows.length === 0) return;

  const slug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(slug)) return;

  const schemaName = `office_${slug}`;
  const activitySourceEntityType = payload.dealId ? "deal" : payload.contactId ? "contact" : null;
  const activitySourceEntityId = payload.dealId ?? payload.contactId ?? null;

  if (activitySourceEntityType && activitySourceEntityId) {
    await workerPool.query(
      `INSERT INTO ${schemaName}.activities
         (type, responsible_user_id, performed_by_user_id, source_entity_type, source_entity_id,
          deal_id, contact_id, subject, occurred_at)
         VALUES ('task_completed', $1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        payload.completedBy,
        payload.completedBy,
        activitySourceEntityType,
        activitySourceEntityId,
        payload.dealId ?? null,
        payload.contactId ?? null,
        `Completed: ${payload.title}`,
      ]
    );
  }

  if (payload.dealId) {
    await workerPool.query(
      `UPDATE ${schemaName}.deals
         SET last_activity_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
      [payload.dealId]
    );
  }

  if (payload.type === "touchpoint" && payload.contactId) {
    await workerPool.query(
      `UPDATE ${schemaName}.contacts
         SET first_outreach_completed = true,
             last_contacted_at = NOW(),
             touchpoint_count = touchpoint_count + 1
         WHERE id = $1 AND first_outreach_completed = false`,
      [payload.contactId]
    );
  }

  const suppressionWindowDays =
    typeof payload.suppressionWindowDays === "number" && Number.isFinite(payload.suppressionWindowDays)
      ? Math.max(0, payload.suppressionWindowDays)
      : null;

  if (payload.originRule && payload.dedupeKey && suppressionWindowDays != null) {
    const resolvedAt = new Date();
    const suppressedUntil = new Date(
      resolvedAt.getTime() + suppressionWindowDays * 24 * 60 * 60 * 1000
    );

    await workerPool.query(
      `INSERT INTO ${schemaName}.task_resolution_state
         (office_id, task_id, origin_rule, dedupe_key, resolution_status, resolution_reason, resolved_at, suppressed_until, entity_snapshot)
         VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $8)
         ON CONFLICT (origin_rule, dedupe_key) DO UPDATE
         SET office_id = EXCLUDED.office_id,
             task_id = EXCLUDED.task_id,
             resolution_status = EXCLUDED.resolution_status,
             resolution_reason = EXCLUDED.resolution_reason,
             resolved_at = EXCLUDED.resolved_at,
             suppressed_until = EXCLUDED.suppressed_until,
             entity_snapshot = EXCLUDED.entity_snapshot,
             updated_at = NOW()`,
      [
        officeId,
        payload.taskId,
        payload.originRule,
        payload.dedupeKey,
        payload.reasonCode ?? payload.type ?? "task_completed",
        resolvedAt,
        suppressedUntil,
        payload.entitySnapshot ?? null,
      ]
    );
  }
}
