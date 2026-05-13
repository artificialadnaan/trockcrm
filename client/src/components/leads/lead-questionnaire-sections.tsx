import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  LeadAnswerValue,
  LeadQuestionnaireNode,
  LegacyLeadQuestionnaireAnswer,
} from "@/hooks/use-leads";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  normalizeQuestionOptions,
  questionnaireRevealMatches,
} from "./questionnaire-display";

interface LeadQuestionnaireSectionsProps {
  nodes: LeadQuestionnaireNode[];
  answers: Record<string, LeadAnswerValue>;
  onAnswerChange: (key: string, value: LeadAnswerValue) => void;
  legacyAnswers?: LegacyLeadQuestionnaireAnswer[];
  showLegacyAnswers?: boolean;
}

function isVisibleQuestion(
  nodeId: string,
  nodeById: Map<string, LeadQuestionnaireNode>,
  answers: Record<string, LeadAnswerValue>,
  visibleCache: Map<string, boolean>
): boolean {
  const cached = visibleCache.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }

  const node = nodeById.get(nodeId);
  if (!node) {
    visibleCache.set(nodeId, false);
    return false;
  }

  if (!node.parentNodeId) {
    visibleCache.set(nodeId, true);
    return true;
  }

  if (!isVisibleQuestion(node.parentNodeId, nodeById, answers, visibleCache)) {
    visibleCache.set(nodeId, false);
    return false;
  }

  const parent = nodeById.get(node.parentNodeId);
  if (!parent) {
    visibleCache.set(nodeId, false);
    return false;
  }

  const parentAnswer = answers[parent.key];
  const visible = questionnaireRevealMatches(parentAnswer, node.parentOptionValue);

  visibleCache.set(nodeId, visible);
  return visible;
}

function getQuestionInputType(node: LeadQuestionnaireNode) {
  if (node.inputType === "textarea") return "textarea";
  if (node.inputType === "boolean") return "boolean";
  if (node.inputType === "date") return "date";
  if (node.inputType === "multiselect") return "multiselect";
  if (node.inputType === "currency" || node.inputType === "number") return "number";
  if (Array.isArray(node.options) && node.options.length > 0) return "select";
  return "text";
}

function QuestionLabel({
  htmlFor,
  children,
  required = false,
}: {
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <Label htmlFor={htmlFor}>
      {children}
      {required ? (
        <span className="text-red-600" aria-hidden="true">
          {" "}
          *
        </span>
      ) : null}
    </Label>
  );
}

export function LeadQuestionnaireSections({
  nodes,
  answers,
  onAnswerChange,
  legacyAnswers,
  showLegacyAnswers = false,
}: LeadQuestionnaireSectionsProps) {
  const [openScopeGroups, setOpenScopeGroups] = useState<Record<string, boolean>>({});
  const scopedNodes = useMemo(() => nodes.filter((node) => node.nodeType === "question"), [nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const visibleNodes = useMemo(() => {
    const visibleCache = new Map<string, boolean>();

    return scopedNodes
      .filter((node) => isVisibleQuestion(node.id, nodeById, answers, visibleCache))
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }, [answers, nodeById, scopedNodes]);
  const baselineNodes = useMemo(
    () => visibleNodes.filter((node) => (node.sectionKey ?? "baseline") === "baseline"),
    [visibleNodes]
  );
  const propertyNodes = useMemo(
    () => visibleNodes.filter((node) => node.sectionKey === "property"),
    [visibleNodes]
  );
  const scopeGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        label: string;
        order: number;
        nodes: LeadQuestionnaireNode[];
        appliesNode: LeadQuestionnaireNode | null;
      }
    >();

    for (const node of scopedNodes.filter((entry) => entry.sectionKey === "scope" && entry.groupKey)) {
      const groupKey = node.groupKey!;
      const current = groups.get(groupKey) ?? {
        key: groupKey,
        label: node.groupLabel ?? groupKey,
        order: node.groupOrder ?? 0,
        nodes: [],
        appliesNode: null,
      };
      current.nodes.push(node);
      if (!node.parentNodeId && (node.key.endsWith("_applies") || node.displayOrder === 0)) {
        current.appliesNode = node;
      }
      groups.set(groupKey, current);
    }

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        nodes: group.nodes.sort((left, right) => left.displayOrder - right.displayOrder),
      }))
      .sort((left, right) => left.order - right.order);
  }, [scopedNodes]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);

  useEffect(() => {
    setOpenScopeGroups((current) => {
      let changed = false;
      const next = { ...current };

      for (const group of scopeGroups) {
        const appliesAnswered = group.appliesNode ? answers[group.appliesNode.key] === true : false;
        const childAnswered = group.nodes
          .filter((node) => node.id !== group.appliesNode?.id)
          .some((node) => answers[node.key] != null);

        if ((appliesAnswered || childAnswered) && !next[group.key]) {
          next[group.key] = true;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [answers, scopeGroups]);

  const toggleMultiselectAnswer = (key: string, optionValue: string, checked: boolean) => {
    const currentValue = answers[key];
    const currentValues = Array.isArray(currentValue) ? currentValue : [];
    const nextValues = checked
      ? Array.from(new Set([...currentValues, optionValue]))
      : currentValues.filter((value) => value !== optionValue);
    onAnswerChange(key, nextValues);
  };

  const renderQuestion = (node: LeadQuestionnaireNode, options?: { nested?: boolean }) => {
    const inputType = getQuestionInputType(node);
    const currentValue = answers[node.key];
    const questionOptions = normalizeQuestionOptions(node.options);

    return (
      <div
        key={node.id}
        data-question-key={node.key}
        className={`space-y-2 rounded-md border p-3 ${options?.nested ? "bg-muted/20" : ""}`}
      >
        <QuestionLabel htmlFor={node.key} required={node.isRequired}>
          {node.label}
        </QuestionLabel>
        {node.prompt && <p className="text-sm text-muted-foreground">{node.prompt}</p>}
        {inputType === "textarea" ? (
          <textarea
            id={node.key}
            className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={typeof currentValue === "string" ? currentValue : ""}
            onChange={(event) => onAnswerChange(node.key, event.target.value)}
          />
        ) : inputType === "boolean" ? (
          <Select
            value={typeof currentValue === "boolean" ? String(currentValue) : "__unanswered__"}
            onValueChange={(value) =>
              onAnswerChange(node.key, !value || value === "__unanswered__" ? null : value === "true")
            }
          >
            <SelectTrigger id={node.key}>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__unanswered__">Unanswered</SelectItem>
              <SelectItem value="true">Yes</SelectItem>
              <SelectItem value="false">No</SelectItem>
            </SelectContent>
          </Select>
        ) : inputType === "select" ? (
          <Select
            value={typeof currentValue === "string" ? currentValue : "__unanswered__"}
            onValueChange={(value) => onAnswerChange(node.key, !value || value === "__unanswered__" ? null : value)}
          >
            <SelectTrigger id={node.key}>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__unanswered__">Unanswered</SelectItem>
              {questionOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : inputType === "multiselect" ? (
          <div className="grid gap-2 rounded-md border bg-background p-3 sm:grid-cols-2">
            {questionOptions.map((option) => {
              const selected = Array.isArray(currentValue) && currentValue.includes(option.value);
              return (
                <label key={option.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    value={option.value}
                    className="h-4 w-4 rounded border-input"
                    checked={selected}
                    onChange={(event) => toggleMultiselectAnswer(node.key, option.value, event.target.checked)}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
        ) : (
          <Input
            id={node.key}
            type={inputType === "date" ? "date" : inputType === "number" ? "number" : "text"}
            value={
              typeof currentValue === "number"
                ? String(currentValue)
                : typeof currentValue === "string"
                  ? currentValue
                  : ""
            }
            onChange={(event) =>
              onAnswerChange(
                node.key,
                inputType === "number"
                  ? event.target.value.trim() === ""
                    ? null
                    : Number(event.target.value)
                  : event.target.value
              )
            }
          />
        )}
      </div>
    );
  };

  return (
    <>
      {baselineNodes.map((node) => renderQuestion(node))}

      {propertyNodes.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Property/Building Info</h3>
          {propertyNodes.map((node) => renderQuestion(node))}
        </section>
      ) : null}

      {scopeGroups.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Scope</h3>
          {scopeGroups.map((group) => {
            const isOpen = openScopeGroups[group.key] ?? false;
            const applies = group.appliesNode ? answers[group.appliesNode.key] === true : false;
            const visibleGroupNodes = group.nodes.filter((node) => visibleNodeIds.has(node.id));

            return (
              <div key={group.key} data-scope-group={group.key} className="rounded-md border">
                {/* The applies question stays inside the collapsed group so every scope section uses the same accordion pattern. */}
                <button
                  type="button"
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  onClick={() => setOpenScopeGroups((current) => ({ ...current, [group.key]: !isOpen }))}
                >
                  <span className="font-medium">{group.label}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      applies
                        ? "border-green-200 bg-green-50 text-green-700"
                        : "border-muted bg-muted/50 text-muted-foreground"
                    }`}
                  >
                    {applies ? "Applies" : "Not selected"}
                  </span>
                </button>
                {isOpen ? (
                  <div className="space-y-3 border-t p-4">
                    {visibleGroupNodes.map((node) =>
                      renderQuestion(node, { nested: node.id !== group.appliesNode?.id })
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      {showLegacyAnswers && legacyAnswers?.length ? (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">Legacy / Archived Answers</summary>
          <div className="mt-3 space-y-2">
            {legacyAnswers.map((answer) => (
              <div key={answer.questionId} className="rounded-md border bg-muted/20 p-3 text-sm">
                <p className="font-medium">{answer.label}</p>
                <p className="text-muted-foreground">
                  {Array.isArray(answer.value) ? answer.value.join(", ") : String(answer.value ?? "Unanswered")}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}
