export const CLEANUP_RECORD_TYPES = ["deal", "lead", "contact", "company"] as const;
export type CleanupRecordType = (typeof CLEANUP_RECORD_TYPES)[number];

export const CLEANUP_STATUSES = ["pending", "cleaned", "skipped", "bulk_passed"] as const;
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

export const SKIP_REASONS = [
  "contact_left_company",
  "deal_stalled",
  "customer_unreachable",
  "record_is_duplicate",
  "record_is_junk",
  "other",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
