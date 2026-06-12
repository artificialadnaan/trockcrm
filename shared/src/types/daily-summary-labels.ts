// Single source of truth for Daily Pulse breakdown wording, consumed by BOTH the email template
// (server) and the token-guarded page (client) so the two can never drift. Covers the structural
// buckets (created/moves/edits/uploads/reports) AND every activity type in ACTIVITY_TYPES, each with a
// count-correct [singular, plural] pair so the line reads "1 note" / "2 notes", never "1 notes".

/** [singular, plural]. "created" is a count-invariant past participle; "go/no-go" stays invariant too. */
export const BREAKDOWN_LABELS: Record<string, readonly [string, string]> = {
  // structural buckets
  created: ["created", "created"],
  moves: ["move", "moves"],
  edits: ["edit", "edits"],
  uploads: ["upload", "uploads"],
  reports: ["report", "reports"],
  // activity types (must stay in sync with ACTIVITY_TYPES in enums.ts)
  call: ["call", "calls"],
  note: ["note", "notes"],
  meeting: ["meeting", "meetings"],
  email: ["email", "emails"],
  task_completed: ["task completed", "tasks completed"],
  voicemail: ["voicemail", "voicemails"],
  lunch: ["lunch", "lunches"],
  site_visit: ["site visit", "site visits"],
  proposal_sent: ["proposal sent", "proposals sent"],
  redline_review: ["redline review", "redline reviews"],
  go_no_go: ["go/no-go", "go/no-go"],
  follow_up: ["follow-up", "follow-ups"],
  support_request: ["support request", "support requests"],
};

/**
 * Count-correct label for a breakdown bucket. A known key returns its singular/plural per `n`; an
 * unknown activity type is humanized (underscores → spaces) and shown as-is for both counts — readable
 * beats a naive "+s" that would yield "task completeds".
 */
export function breakdownLabel(key: string, n: number): string {
  const pair = BREAKDOWN_LABELS[key];
  if (pair) return n === 1 ? pair[0] : pair[1];
  return key.replace(/_/g, " ");
}
