import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  files,
  leadQuestionAnswerHistory,
  leadQuestionAnswers,
  projectTypeQuestionNodes,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { and, eq } from "drizzle-orm";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type LeadQuestionAnswerValue = string | boolean | number | string[] | null;

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
  sectionKey: string | null;
  groupKey: string | null;
  groupLabel: string | null;
  groupOrder: number | null;
  isActive: boolean;
}

export interface LegacyQuestionnaireAnswer {
  questionId: string;
  key: string;
  label: string;
  inputType: string | null;
  options: unknown;
  value: LeadQuestionAnswerValue;
  displayOrder: number;
  projectTypeId: string | null;
  sectionKey: string | null;
  groupKey: string | null;
  groupLabel: string | null;
  groupOrder: number | null;
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
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
}

function isTruthyRevealValue(value: LeadQuestionAnswerValue | undefined) {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return Boolean(value);
}

function revealValueMatches(parentAnswer: LeadQuestionAnswerValue | undefined, parentOptionValue: string | null) {
  if (parentOptionValue == null) {
    return isTruthyRevealValue(parentAnswer);
  }

  if (Array.isArray(parentAnswer)) {
    return parentAnswer.map(String).includes(parentOptionValue);
  }

  return String(parentAnswer ?? "") === parentOptionValue;
}

function valuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function normalizeAnswerValueForNode(
  node: QuestionnaireNode,
  value: LeadQuestionAnswerValue | undefined
): LeadQuestionAnswerValue {
  if (node.inputType !== "multiselect") {
    return value ?? null;
  }

  if (value == null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AppError(400, `Multi-select answer ${node.key} must be an array of strings.`);
  }

  return value;
}

const SECTION_ORDER: Record<string, number> = {
  baseline: 0,
  property: 1,
  scope: 2,
};
const CLIENT_PROVIDED_DOCS_TAG = "client_provided_docs";

function sortQuestionnaireNodes(left: QuestionnaireNode, right: QuestionnaireNode) {
  const leftSection = SECTION_ORDER[left.sectionKey ?? ""] ?? 99;
  const rightSection = SECTION_ORDER[right.sectionKey ?? ""] ?? 99;
  if (leftSection !== rightSection) return leftSection - rightSection;

  const leftGroup = left.groupOrder ?? 0;
  const rightGroup = right.groupOrder ?? 0;
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;

  return left.displayOrder - right.displayOrder;
}

export async function listQuestionnaireNodes(tenantDb: TenantDb): Promise<QuestionnaireNode[]> {
  return listAllQuestionnaireNodes(tenantDb);
}

export async function listAllQuestionnaireNodes(tenantDb: TenantDb): Promise<QuestionnaireNode[]> {
  const rows = await tenantDb.select().from(projectTypeQuestionNodes);

  return rows
    .filter((row) => row.isActive && row.projectTypeId == null)
    .sort(sortQuestionnaireNodes);
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

  const nodes = await listQuestionnaireNodes(tenantDb);
  const keyByQuestionId = new Map(nodes.map((node) => [node.id, node.key]));

  return rows.reduce<Record<string, LeadQuestionAnswerValue>>((accumulator, row) => {
    const key = keyByQuestionId.get(row.questionId);
    if (key) {
      accumulator[key] = (row.valueJson as LeadQuestionAnswerValue | undefined) ?? null;
    }
    return accumulator;
  }, {});
}

export async function listLegacyLeadQuestionAnswers(
  tenantDb: TenantDb,
  leadId: string
): Promise<LegacyQuestionnaireAnswer[]> {
  const rows = await tenantDb
    .select()
    .from(leadQuestionAnswers)
    .where(eq(leadQuestionAnswers.leadId, leadId));

  if (rows.length === 0) {
    return [];
  }

  const nodes = await tenantDb.select().from(projectTypeQuestionNodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const activeUniversalIds = new Set(
    nodes
      .filter((node) => node.isActive && node.projectTypeId == null)
      .map((node) => node.id)
  );

  return rows
    .flatMap((row) => {
      const node = nodeById.get(row.questionId);
      if (!node || activeUniversalIds.has(node.id)) {
        return [];
      }

      return [
        {
          questionId: node.id,
          key: node.key,
          label: node.label,
          inputType: node.inputType,
          options: node.options,
          value: (row.valueJson as LeadQuestionAnswerValue | undefined) ?? null,
          displayOrder: node.displayOrder,
          projectTypeId: node.projectTypeId,
          sectionKey: node.sectionKey,
          groupKey: node.groupKey,
          groupLabel: node.groupLabel,
          groupOrder: node.groupOrder,
        },
      ];
    })
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

export async function getLeadQuestionnaireSnapshot(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    projectTypeId: string | null;
  }
) {
  const [nodes, allNodes, answers, legacyAnswers] = await Promise.all([
    listQuestionnaireNodes(tenantDb),
    listAllQuestionnaireNodes(tenantDb),
    listLeadQuestionAnswers(tenantDb, input.leadId),
    listLegacyLeadQuestionAnswers(tenantDb, input.leadId),
  ]);

  return {
    projectTypeId: input.projectTypeId,
    nodes,
    allNodes,
    answers,
    legacyAnswers,
  };
}

export async function getQuestionnaireTemplateSnapshot(
  tenantDb: TenantDb,
  projectTypeId: string | null
) {
  const [nodes, allNodes] = await Promise.all([
    listQuestionnaireNodes(tenantDb),
    listAllQuestionnaireNodes(tenantDb),
  ]);

  const normalizeCreateModeNode = (node: QuestionnaireNode): QuestionnaireNode | null => {
    // First-class create-gate fields are collected above the V2 questionnaire.
    // Keep V2 nodes available for edit-mode snapshots and answer mirroring.
    if (node.key === "poc" || node.key === "bid_due_date") {
      return null;
    }
    return { ...node, isRequired: false };
  };

  return {
    projectTypeId,
    nodes: nodes.map(normalizeCreateModeNode).filter((node): node is QuestionnaireNode => Boolean(node)),
    allNodes: allNodes.map(normalizeCreateModeNode).filter((node): node is QuestionnaireNode => Boolean(node)),
    answers: {},
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
  const visible = revealValueMatches(parentAnswer, node.parentOptionValue);

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

export interface LeadQuestionGateMissing {
  qualificationFields: string[];
  projectTypeQuestionIds: string[];
  missingScopeSelection: boolean;
}

export async function applyLeadAttachmentAnswers(
  tenantDb: TenantDb,
  leadId: string,
  answers: Record<string, unknown>
): Promise<Record<string, LeadQuestionAnswerValue>> {
  const leadFiles = await tenantDb
    .select({
      tags: files.tags,
    })
    .from(files)
    .where(and(eq(files.leadId, leadId), eq(files.isActive, true)));
  const hasClientProvidedDocs = leadFiles.some((file) =>
    file.tags.some((tag) => tag.toLowerCase() === CLIENT_PROVIDED_DOCS_TAG)
  );

  if (hasClientProvidedDocs) {
    return {
      ...answers,
      [CLIENT_PROVIDED_DOCS_TAG]: "uploaded",
    };
  }

  if (answers[CLIENT_PROVIDED_DOCS_TAG] === "uploaded") {
    return {
      ...answers,
      [CLIENT_PROVIDED_DOCS_TAG]: null,
    };
  }

  return answers as Record<string, LeadQuestionAnswerValue>;
}

function hasSatisfiedScopeGroup(
  nodes: QuestionnaireNode[],
  answers: Record<string, LeadQuestionAnswerValue>,
  missingRequiredKeys: string[]
) {
  const missingRequiredKeySet = new Set(missingRequiredKeys);
  const scopeGroups = new Map<string, QuestionnaireNode[]>();

  for (const node of nodes) {
    if (node.sectionKey !== "scope" || !node.groupKey) continue;
    const group = scopeGroups.get(node.groupKey) ?? [];
    group.push(node);
    scopeGroups.set(node.groupKey, group);
  }

  for (const group of scopeGroups.values()) {
    const appliesNode =
      group.find((node) => node.key.endsWith("_applies") && !node.parentNodeId) ??
      group.find((node) => node.displayOrder === 0 && !node.parentNodeId);
    if (!appliesNode || answers[appliesNode.key] !== true) {
      continue;
    }

    const missingInGroup = group.some((node) => missingRequiredKeySet.has(node.key));
    if (!missingInGroup) {
      return true;
    }
  }

  return false;
}

/**
 * Pure evaluation of the V2 lead question gate. Returns the missing items.
 * Caller must compute existingCustomerStatus and pass it in.
 */
export async function evaluateLeadQuestionGate(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    projectTypeId: string | null;
    qualificationPayload: Record<string, LeadQuestionAnswerValue>;
    leadQuestionAnswers?: Record<string, LeadQuestionAnswerValue>;
    existingCustomerStatus: string | null;
  }
): Promise<LeadQuestionGateMissing> {
  const [storedAnswers, nodes] = await Promise.all([
    listLeadQuestionAnswers(tenantDb, input.leadId),
    listQuestionnaireNodes(tenantDb),
  ]);
  const mergedAnswers = await applyLeadAttachmentAnswers(tenantDb, input.leadId, {
    ...storedAnswers,
    ...(input.leadQuestionAnswers ?? {}),
  });
  const qualificationFields = ["estimated_value", "timeline_status"].filter(
    (fieldId) => !isAnsweredQuestionValue(input.qualificationPayload[fieldId])
  );
  if (!isAnsweredQuestionValue(input.existingCustomerStatus)) {
    qualificationFields.unshift("existing_customer_status");
  }
  const projectTypeQuestionIds = listMissingRequiredQuestionKeys(nodes, mergedAnswers);
  const missingScopeSelection = !hasSatisfiedScopeGroup(nodes, mergedAnswers, projectTypeQuestionIds);

  return {
    qualificationFields,
    projectTypeQuestionIds,
    missingScopeSelection,
  };
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
  const { leadId, changedBy, answers, changedAt } = input;
  const answerEntries = Object.entries(answers);

  if (answerEntries.length === 0) {
    return false;
  }

  const [nodes, existingRows] = await Promise.all([
    listQuestionnaireNodes(tenantDb),
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

    const nextValue = normalizeAnswerValueForNode(node, rawValue);
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
