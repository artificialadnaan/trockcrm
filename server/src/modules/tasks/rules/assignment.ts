import type { AssignmentContext, AssignmentResult } from "./types.js";

export const ASSIGNMENT_ORDER = [
  "manual_override",
  "deal_owner",
  "contact_linked_rep",
  "recent_actor",
  "office_fallback",
] as const;

function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export async function assignTaskFromContext(ctx: AssignmentContext): Promise<AssignmentResult> {
  if (isPresent(ctx.manualOverrideId)) {
    return {
      assignedTo: ctx.manualOverrideId,
      machineReason: { code: "manual_override", detail: ctx.entityId },
    };
  }

  if (isPresent(ctx.dealOwnerId)) {
    return {
      assignedTo: ctx.dealOwnerId,
      machineReason: { code: "deal_owner", detail: ctx.entityId },
    };
  }

  if (isPresent(ctx.contactLinkedRepId)) {
    return {
      assignedTo: ctx.contactLinkedRepId,
      machineReason: { code: "contact_linked_rep", detail: ctx.entityId },
    };
  }

  if (isPresent(ctx.recentActorId)) {
    return {
      assignedTo: ctx.recentActorId,
      machineReason: { code: "recent_actor", detail: ctx.entityId },
    };
  }

  if (isPresent(ctx.officeFallbackId)) {
    return {
      assignedTo: ctx.officeFallbackId,
      machineReason: { code: "office_fallback", detail: ctx.entityId },
    };
  }

  return {
    assignedTo: null,
    machineReason: { code: "no_assignment_candidate", detail: ctx.entityId },
  };
}
