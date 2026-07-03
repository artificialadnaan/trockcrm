/**
 * One entry in a deal's DESCRIPTION change-log. Every edit to `deals.description` appends a row to the
 * per-tenant `deal_history` table (field_name = "description"); this is the read-side shape the deal
 * detail page renders under the description, newest first. `changedByName` is resolved from the actor's
 * user record (null if the user row is gone).
 */
export interface DealDescriptionHistoryEntry {
  id: string;
  /** The description BEFORE this edit (null when it was previously empty). */
  oldValue: string | null;
  /** The description AFTER this edit (null when the edit cleared it). */
  newValue: string | null;
  changedBy: string | null;
  changedByName: string | null;
  source: string | null;
  /** ISO-8601 timestamp of the edit. */
  changedAt: string;
}
