// Field-responder roster shared types. A GLOBAL managed roster of field Superintendents & Project
// Managers ("field responders") — the managed source for corrective-action recipient emails, replacing
// per-deal retyping. The role union is the single source of truth for both the DB CHECK
// (field_responders.role IN (...)) and the client picker; keep it in lockstep with migration 0198's
// CHECK and shared/src/schema/tenant/field-responders.ts.

/** The two roster roles. Mirrors the field_responders.role CHECK (migration 0198). */
export const FIELD_RESPONDER_ROLES = ["superintendent", "project_manager"] as const;
export type FieldResponderRole = (typeof FIELD_RESPONDER_ROLES)[number];

/** Human labels for the roster roles (for badges / pickers). */
export const FIELD_RESPONDER_ROLE_LABELS: Record<FieldResponderRole, string> = {
  superintendent: "Superintendent",
  project_manager: "Project Manager",
};

/** Narrowing guard — true when `value` is one of the two allowed roster roles. */
export function isFieldResponderRole(value: unknown): value is FieldResponderRole {
  return (
    typeof value === "string" &&
    (FIELD_RESPONDER_ROLES as readonly string[]).includes(value)
  );
}

/** A roster person as returned by the field-responders API. `assignmentCount` = # distinct ACTIVE deals
 *  where this responder is an active superintendent / project_manager deal_team_members row. */
export interface FieldResponder {
  id: string;
  name: string;
  email: string;
  role: FieldResponderRole;
  isActive: boolean;
  assignmentCount: number;
}

/** One deal a responder is currently the super / PM on (GET /field-responders/:id/assignments). */
export interface FieldResponderAssignment {
  dealId: string;
  dealName: string;
  role: FieldResponderRole;
}
