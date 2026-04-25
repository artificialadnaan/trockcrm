import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  leadQuestionAnswerHistory,
  leadQuestionAnswers,
  projectTypeQuestionNodes,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { eq } from "drizzle-orm";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type LeadQuestionAnswerValue = string | boolean | number | null;

export interface QuestionnaireNode {
  id: string;
  projectTypeId: string | null;
  parentNodeId: string | null;
  parentOptionValue: string | null;
  nodeType: string;
  key: string;
  label: string;
  prompt: string | null;
  inputType: string | null;
  options: unknown;
  isRequired: boolean;
  displayOrder: number;
  isActive: boolean;
}

export function isLeadEditV2Enabled() {
  return process.env.ENABLE_LEAD_EDIT_V2 === "true";
}

export function isAnsweredQuestionValue(value: LeadQuestionAnswerValue | undefined): boolean {
  if (value == null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}

function isTruthyRevealValue(value: LeadQuestionAnswerValue | undefined) {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return Boolean(value);
}

function valuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export async function listQuestionnaireNodes(
  tenantDb: TenantDb,
  projectTypeId: string | null
): Promise<QuestionnaireNode[]> {
  return (await listAllQuestionnaireNodes(tenantDb)).filter(
    (row) => row.projectTypeId == null || (projectTypeId != null && row.projectTypeId === projectTypeId)
  );
}

export async function listAllQuestionnaireNodes(tenantDb: TenantDb): Promise<QuestionnaireNode[]> {
  const rows = await tenantDb.select().from(projectTypeQuestionNodes);

  return rows
    .filter((row) => row.isActive)
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

export async function listLeadQuestionAnswers(
  tenantDb: TenantDb,
  leadId: string
): Promise<Record<string, LeadQuestionAnswerValue>> {
  const rows = await tenantDb
    .select()
    .from(leadQuestionAnswers)
    .where(eq(leadQuestionAnswers.leadId, leadId));

  if (rows.length === 0) {
    return {};
  }

  const nodes = await tenantDb.select().from(projectTypeQuestionNodes);
  const keyByQuestionId = new Map(nodes.map((node) => [node.id, node.key]));

  return rows.reduce<Record<string, LeadQuestionAnswerValue>>((accumulator, row) => {
    const key = keyByQuestionId.get(row.questionId);
    if (key) {
      accumulator[key] = (row.valueJson as LeadQuestionAnswerValue | undefined) ?? null;
    }
    return accumulator;
  }, {});
}

export async function getLeadQuestionnaireSnapshot(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    projectTypeId: string | null;
  }
) {
  const [nodes, allNodes, answers] = await Promise.all([
    listQuestionnaireNodes(tenantDb, input.projectTypeId),
    listAllQuestionnaireNodes(tenantDb),
    listLeadQuestionAnswers(tenantDb, input.leadId),
  ]);

  return {
    projectTypeId: input.projectTypeId,
    nodes,
    allNodes,
    answers,
  };
}

function isNodeVisible(
  node: QuestionnaireNode,
  nodeById: Map<string, QuestionnaireNode>,
  answers: Record<string, LeadQuestionAnswerValue>,
  visibleCache: Map<string, boolean>
): boolean {
  const cached = visibleCache.get(node.id);
  if (cached !== undefined) {
    return cached;
  }

  if (!node.parentNodeId) {
    visibleCache.set(node.id, true);
    return true;
  }

  const parent = nodeById.get(node.parentNodeId);
  if (!parent) {
    visibleCache.set(node.id, false);
    return false;
  }

  if (!isNodeVisible(parent, nodeById, answers, visibleCache)) {
    visibleCache.set(node.id, false);
    return false;
  }

  const parentAnswer = answers[parent.key];
  const visible =
    node.parentOptionValue != null
      ? String(parentAnswer ?? "") === node.parentOptionValue
      : isTruthyRevealValue(parentAnswer);

  visibleCache.set(node.id, visible);
  return visible;
}

export function listMissingRequiredQuestionKeys(
  nodes: QuestionnaireNode[],
  answers: Record<string, LeadQuestionAnswerValue>
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visibleCache = new Map<string, boolean>();

  return nodes
    .filter((node) => node.nodeType === "question" && node.isRequired)
    .filter((node) => isNodeVisible(node, nodeById, answers, visibleCache))
    .filter((node) => !isAnsweredQuestionValue(answers[node.key]))
    .map((node) => node.key);
}

export async function upsertLeadQuestionAnswerSet(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    projectTypeId: string | null;
    changedBy: string;
    answers: Record<string, LeadQuestionAnswerValue>;
    changedAt: Date;
  }
) {
  const { leadId, projectTypeId, changedBy, answers, changedAt } = input;
  const answerEntries = Object.entries(answers);

  if (answerEntries.length === 0) {
    return false;
  }

  const [nodes, existingRows] = await Promise.all([
    listQuestionnaireNodes(tenantDb, projectTypeId),
    tenantDb.select().from(leadQuestionAnswers).where(eq(leadQuestionAnswers.leadId, leadId)),
  ]);

  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const existingByQuestionId = new Map(existingRows.map((row) => [row.questionId, row]));

  let wroteAny = false;

  for (const [key, rawValue] of answerEntries) {
    const node = nodeByKey.get(key);
    if (!node) {
      throw new AppError(400, `Unknown lead questionnaire key: ${key}`);
    }

    const nextValue = rawValue ?? null;
    const existing = existingByQuestionId.get(node.id) ?? null;
    const previousValue = (existing?.valueJson as LeadQuestionAnswerValue | undefined) ?? null;

    if (valuesEqual(previousValue, nextValue)) {
      continue;
    }

    wroteAny = true;

    await tenantDb.insert(leadQuestionAnswerHistory).values({
      leadId,
      questionId: node.id,
      oldValueJson: previousValue,
      newValueJson: nextValue,
      changedBy,
      changedAt,
    });

    if (existing) {
      await tenantDb
        .update(leadQuestionAnswers)
        .set({
          valueJson: nextValue,
          updatedBy: changedBy,
          updatedAt: changedAt,
        })
        .where(eq(leadQuestionAnswers.id, existing.id));
      continue;
    }

    await tenantDb.insert(leadQuestionAnswers).values({
      leadId,
      questionId: node.id,
      valueJson: nextValue,
      updatedBy: changedBy,
      createdAt: changedAt,
      updatedAt: changedAt,
    });
  }

  return wroteAny;
}
