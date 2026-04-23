import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealDepartmentHandoffs } from "@trock-crm/shared/schema";
import type { DealPipelineDisposition, WorkflowRoute } from "@trock-crm/shared/types";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export type DealDepartment =
  | "sales"
  | "estimating"
  | "client_services"
  | "operations";

export interface DealDepartmentOwnership {
  currentDepartment: DealDepartment;
  acceptanceStatus: "pending" | "accepted";
  effectiveOwnerUserId: string | null;
  pendingDepartment: DealDepartment | null;
}

type DealDepartmentHandoffRecord = {
  fromDepartment: string;
  toDepartment: string;
  acceptanceStatus: string;
  effectiveOwnerUserId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
};

function isDepartment(value: string): value is DealDepartment {
  return ["sales", "estimating", "client_services", "operations"].includes(value);
}

export function inferDealDepartment(input: {
  stageSlug?: string | null;
  pipelineDisposition?: DealPipelineDisposition | null;
  workflowRoute?: WorkflowRoute | null;
}): DealDepartment {
  if (
    input.stageSlug &&
    ["sent_to_production", "service_sent_to_production"].includes(input.stageSlug)
  ) {
    return "operations";
  }

  if (input.pipelineDisposition === "service" || input.workflowRoute === "service") {
    return "client_services";
  }

  if (
    input.stageSlug &&
    [
      "estimate_in_progress",
      "estimate_under_review",
      "estimate_sent_to_client",
      "service_estimating",
      "service_estimate_under_review",
      "service_estimate_sent_to_client",
    ].includes(
      input.stageSlug
    )
  ) {
    return "estimating";
  }

  return "sales";
}

export function deriveDealDepartmentOwnership(
  deal: {
    stageSlug?: string | null;
    pipelineDisposition?: DealPipelineDisposition | null;
    workflowRoute?: WorkflowRoute | null;
  },
  handoffs: DealDepartmentHandoffRecord[]
): DealDepartmentOwnership {
  const sorted = [...handoffs].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime()
  );
  const latestPending = sorted.find(
    (handoff) =>
      handoff.acceptanceStatus === "pending" &&
      isDepartment(handoff.fromDepartment) &&
      isDepartment(handoff.toDepartment)
  );
  const latestAccepted = sorted.find(
    (handoff) =>
      handoff.acceptanceStatus === "accepted" &&
      isDepartment(handoff.toDepartment)
  );

  if (latestPending && isDepartment(latestPending.fromDepartment) && isDepartment(latestPending.toDepartment)) {
    return {
      currentDepartment: latestPending.fromDepartment,
      acceptanceStatus: "pending",
      effectiveOwnerUserId: latestAccepted?.effectiveOwnerUserId ?? null,
      pendingDepartment: latestPending.toDepartment,
    };
  }

  if (latestAccepted && isDepartment(latestAccepted.toDepartment)) {
    return {
      currentDepartment: latestAccepted.toDepartment,
      acceptanceStatus: "accepted",
      effectiveOwnerUserId: latestAccepted.effectiveOwnerUserId ?? null,
      pendingDepartment: null,
    };
  }

  return {
    currentDepartment: inferDealDepartment(deal),
    acceptanceStatus: "accepted",
    effectiveOwnerUserId: null,
    pendingDepartment: null,
  };
}

export async function getDealDepartmentOwnership(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    stageSlug?: string | null;
    pipelineDisposition?: DealPipelineDisposition | null;
    workflowRoute?: WorkflowRoute | null;
  }
) {
  const handoffs = await tenantDb
    .select({
      fromDepartment: dealDepartmentHandoffs.fromDepartment,
      toDepartment: dealDepartmentHandoffs.toDepartment,
      acceptanceStatus: dealDepartmentHandoffs.acceptanceStatus,
      effectiveOwnerUserId: dealDepartmentHandoffs.effectiveOwnerUserId,
      acceptedAt: dealDepartmentHandoffs.acceptedAt,
      createdAt: dealDepartmentHandoffs.createdAt,
    })
    .from(dealDepartmentHandoffs)
    .where(eq(dealDepartmentHandoffs.dealId, input.dealId))
    .orderBy(desc(dealDepartmentHandoffs.createdAt));

  return deriveDealDepartmentOwnership(input, handoffs);
}
