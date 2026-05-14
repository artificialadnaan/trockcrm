export const PHASE_1_AUDIT_WRITE_SURFACES = [
  "lead.create",
  "lead.update",
  "lead.convert",
  "lead.soft_delete",
  "deal.create",
  "deal.update",
  "deal.stage_transition",
  "deal.proposal_draft",
  "deal.contract_signed_date",
  "deal.soft_delete",
] as const;

export type Phase1AuditWriteSurface = (typeof PHASE_1_AUDIT_WRITE_SURFACES)[number];
