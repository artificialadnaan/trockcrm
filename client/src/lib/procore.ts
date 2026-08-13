/**
 * Re-exported from `shared`, which is where the builder now lives — the SERVER needs the same formula for
 * SyncHub's estimates email, and a second copy is exactly what this indirection exists to prevent. Kept as
 * a local module so existing imports (`@/lib/procore`) do not have to churn.
 */
export { buildProcoreBidBoardProjectUrl } from "@trock-crm/shared/lib/procoreBidBoard";
