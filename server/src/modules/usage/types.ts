/** A single browser session row (one per tab/app load). */
export interface RawSession {
  id: string;
  impersonatorId: string | null;
}

/** A server-stamped heartbeat. */
export interface RawHeartbeat {
  sessionId: string;
  at: Date;
}

/** A server-stamped view/navigation event. */
export interface RawViewEvent {
  sessionId: string;
  at: Date;
  entityType: "deal" | "lead" | "report" | "page" | string;
}

/** An auditLog row used for creates/edits (carries impersonator_id). */
export interface RawAuditRow {
  action: "insert" | "update" | "delete" | "soft_delete" | string;
  tableName: string;
  createdAt: Date;
  impersonatorId: string | null;
}

/** A deal_stage_history row (no impersonator column — see spec caveat). */
export interface RawStageMove {
  createdAt: Date;
}

/** An activities row (no impersonator column). */
export interface RawActivity {
  type: string;
  at: Date;
}

/** A files/photo_tags upload row (no impersonator column). */
export interface RawUpload {
  at: Date;
}

/** Everything computeUsageDaily needs for one (user, date). */
export interface UsageRawInput {
  userId: string;
  date: string; // YYYY-MM-DD (the local calendar day this fold represents)
  sessions: RawSession[];
  heartbeats: RawHeartbeat[];
  viewEvents: RawViewEvent[];
  auditRows: RawAuditRow[];
  stageMoves: RawStageMove[];
  activities: RawActivity[];
  uploads: RawUpload[];
}

/** The breakdown JSONB shape stored on usage_daily. */
export interface UsageBreakdown {
  deal_views: number;
  lead_views: number;
  report_views: number;
  page_views: number;
  creates: number;
  edits: number;
  stage_moves: number;
  uploads: number;
  activities: Record<string, number>; // sub-keyed by activity type
}

/** The per-(user,date) output. Persisted verbatim to usage_daily by the rollup. */
export interface UsageDailyShape {
  userId: string;
  date: string;
  activeSeconds: number;
  sessionCount: number;
  viewCount: number;
  actionCount: number;
  breakdown: UsageBreakdown;
  firstActiveAt: string | null; // ISO string or null
  lastActiveAt: string | null;
}
