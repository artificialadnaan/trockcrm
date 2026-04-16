type TaskCompletionActivityScope = {
  sourceEntityType: "deal" | "contact" | "lead";
  sourceEntityId: string;
  leadId: string | null;
  dealId: string | null;
  contactId: string | null;
};

function getTaskCompletionActivityScope(payload: any): TaskCompletionActivityScope | null {
  const entitySnapshot =
    payload.entitySnapshot && typeof payload.entitySnapshot === "object"
      ? payload.entitySnapshot
      : null;
  const leadId =
    typeof payload.leadId === "string"
      ? payload.leadId
      : typeof entitySnapshot?.leadId === "string"
        ? entitySnapshot.leadId
        : null;

  if (payload.dealId) {
    return {
      sourceEntityType: "deal",
      sourceEntityId: payload.dealId,
      leadId,
      dealId: payload.dealId,
      contactId: payload.contactId ?? null,
    };
  }

  if (leadId) {
    return {
      sourceEntityType: "lead",
      sourceEntityId: leadId,
      leadId,
      dealId: null,
      contactId: payload.contactId ?? null,
    };
  }

  if (payload.contactId) {
    return {
      sourceEntityType: "contact",
      sourceEntityId: payload.contactId,
      leadId: null,
      dealId: null,
      contactId: payload.contactId,
    };
  }

  return null;
}

async function resolveResponsibleUserId(
  workerPool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }> },
  schemaName: string,
  activityScope: TaskCompletionActivityScope,
  fallbackUserId: string
) {
  if (activityScope.sourceEntityType === "deal") {
    const dealResult = await workerPool.query(
      `SELECT assigned_rep_id FROM ${schemaName}.deals WHERE id = $1 LIMIT 1`,
      [activityScope.sourceEntityId]
    );
    return dealResult.rows[0]?.assigned_rep_id ?? fallbackUserId;
  }

  if (activityScope.sourceEntityType === "lead") {
    const leadResult = await workerPool.query(
      `SELECT assigned_rep_id FROM ${schemaName}.leads WHERE id = $1 LIMIT 1`,
      [activityScope.sourceEntityId]
    );
    return leadResult.rows[0]?.assigned_rep_id ?? fallbackUserId;
  }

  return fallbackUserId;
}

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
  const activityScope = getTaskCompletionActivityScope(payload);

  if (activityScope) {
    const responsibleUserId = await resolveResponsibleUserId(
      workerPool,
      schemaName,
      activityScope,
      payload.completedBy
    );
    const performedByUserId =
      payload.completedBy && payload.completedBy !== responsibleUserId
        ? payload.completedBy
        : null;

    await workerPool.query(
      `INSERT INTO ${schemaName}.activities
         (type, responsible_user_id, performed_by_user_id, source_entity_type, source_entity_id,
          lead_id, deal_id, contact_id, subject, occurred_at)
         VALUES ('task_completed', $1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        responsibleUserId,
        performedByUserId,
        activityScope.sourceEntityType,
        activityScope.sourceEntityId,
        activityScope.leadId,
        activityScope.dealId,
        activityScope.contactId,
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
