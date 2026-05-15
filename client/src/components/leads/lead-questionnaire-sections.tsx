import { useEffect, useMemo, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import {
  normalizeQuestionOptions,
  questionnaireRevealMatches,
} from "./questionnaire-display";
import {
  CLEAR_SELECTION_VALUE,
  getNormalizedQuestionInputType,
  normalizeBooleanAnswerForDisplay,
  normalizeDropdownAnswerForDisplay,
} from "./questionnaire-answer-normalization";
import { LeadScopeCardGrid } from "./lead-scope-card-grid";

interface LeadQuestionnaireSectionsProps {
  nodes: LeadQuestionnaireNode[];
  answers: Record<string, LeadAnswerValue>;
  onAnswerChange: (key: string, value: LeadAnswerValue) => void;
  legacyAnswers?: LegacyLeadQuestionnaireAnswer[];
  showLegacyAnswers?: boolean;
  renderQuestionOverride?: (node: LeadQuestionnaireNode) => ReactNode | null;
}

interface ScopeGroup {
  key: string;
  label: string;
  order: number;
  nodes: LeadQuestionnaireNode[];
  appliesNode: LeadQuestionnaireNode | null;
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

function hasAnsweredValue(value: LeadAnswerValue | undefined) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function CurrencyInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        $
      </span>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        className="pl-7"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function LeadQuestionnaireSections({
  nodes,
  answers,
  onAnswerChange,
  legacyAnswers,
  showLegacyAnswers = false,
  renderQuestionOverride,
}: LeadQuestionnaireSectionsProps) {
  const [activeScopeGroupKey, setActiveScopeGroupKey] = useState<string | null>(null);
  const suppressAutoActivateRef = useRef(false);
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
  const scopeGroups = useMemo<ScopeGroup[]>(() => {
    const groups = new Map<string, ScopeGroup>();

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
  const childrenByParentId = useMemo(() => {
    const children = new Map<string, LeadQuestionnaireNode[]>();
    for (const node of scopedNodes) {
      if (!node.parentNodeId) continue;
      const current = children.get(node.parentNodeId) ?? [];
      current.push(node);
      children.set(node.parentNodeId, current.sort((left, right) => left.displayOrder - right.displayOrder));
    }
    return children;
  }, [scopedNodes]);
  const selectedScopeIds = useMemo(
    () =>
      new Set(
        scopeGroups
          .filter((group) => group.appliesNode && answers[group.appliesNode.key] === true)
          .map((group) => group.key)
      ),
    [answers, scopeGroups]
  );
  const scopeCardItems = useMemo(
    () =>
      scopeGroups.map((group) => {
        const answeredCount = group.nodes
          .filter((node) => node.id !== group.appliesNode?.id)
          .filter((node) => hasAnsweredValue(answers[node.key]))
          .length;
        const selected = group.appliesNode ? answers[group.appliesNode.key] === true : false;
        const status = !selected
          ? "Not selected"
          : answeredCount > 0
            ? `In progress - ${answeredCount} answered`
            : "Selected";
        return {
          id: group.key,
          label: group.label,
          status,
          answeredCount,
        };
      }),
    [answers, scopeGroups]
  );

  useEffect(() => {
    if (activeScopeGroupKey && selectedScopeIds.has(activeScopeGroupKey)) {
      return;
    }
    if (activeScopeGroupKey == null && suppressAutoActivateRef.current) {
      suppressAutoActivateRef.current = false;
      return;
    }
    const nextActiveKey = scopeGroups.find((group) => selectedScopeIds.has(group.key))?.key ?? null;
    setActiveScopeGroupKey(nextActiveKey);
  }, [activeScopeGroupKey, scopeGroups, selectedScopeIds]);

  const toggleMultiselectAnswer = (key: string, optionValue: string, checked: boolean) => {
    const currentValue = answers[key];
    const currentValues = Array.isArray(currentValue) ? currentValue : [];
    const nextValues = checked
      ? Array.from(new Set([...currentValues, optionValue]))
      : currentValues.filter((value) => value !== optionValue);
    onAnswerChange(key, nextValues);
  };

  const toggleScopeSelection = (groupKey: string) => {
    const group = scopeGroups.find((entry) => entry.key === groupKey);
    if (!group?.appliesNode) return;
    const selected = answers[group.appliesNode.key] === true;
    const active = activeScopeGroupKey === groupKey;

    if (selected && active) {
      suppressAutoActivateRef.current = true;
      onAnswerChange(group.appliesNode.key, null);
      setActiveScopeGroupKey(null);
      return;
    }

    if (!selected) {
      onAnswerChange(group.appliesNode.key, true);
    }
    setActiveScopeGroupKey(groupKey);
  };

  const activateScope = (groupKey: string) => {
    if (!selectedScopeIds.has(groupKey)) return;
    setActiveScopeGroupKey(groupKey);
  };

  const renderQuestion = (node: LeadQuestionnaireNode, options?: { nested?: boolean }) => {
    const override = renderQuestionOverride?.(node);
    if (override) return override;

    const inputType = getNormalizedQuestionInputType(node);
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
            value={normalizeBooleanAnswerForDisplay(currentValue)}
            onValueChange={(value) =>
              onAnswerChange(
                node.key,
                !value || value === CLEAR_SELECTION_VALUE ? null : value === "true"
              )
            }
          >
            <SelectTrigger id={node.key}>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {!node.isRequired ? (
                <SelectItem value={CLEAR_SELECTION_VALUE}>-- (no selection)</SelectItem>
              ) : null}
              <SelectItem value="true">Yes</SelectItem>
              <SelectItem value="false">No</SelectItem>
            </SelectContent>
          </Select>
        ) : inputType === "select" ? (
          <Select
            value={normalizeDropdownAnswerForDisplay(currentValue)}
            onValueChange={(value) =>
              onAnswerChange(node.key, !value || value === CLEAR_SELECTION_VALUE ? null : value)
            }
          >
            <SelectTrigger id={node.key}>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {!node.isRequired ? (
                <SelectItem value={CLEAR_SELECTION_VALUE}>-- (no selection)</SelectItem>
              ) : null}
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
        ) : inputType === "currency" ? (
          <CurrencyInput
            id={node.key}
            value={
              typeof currentValue === "number"
                ? String(currentValue)
                : typeof currentValue === "string"
                  ? currentValue
                  : ""
            }
            onChange={(value) =>
              onAnswerChange(node.key, value.trim() === "" ? null : Number(value))
            }
          />
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

  const isBranchNode = (node: LeadQuestionnaireNode) =>
    getNormalizedQuestionInputType(node) === "boolean" &&
    (childrenByParentId.get(node.id)?.length ?? 0) > 0;

  const renderNodeTree = (node: LeadQuestionnaireNode, depth = 0): ReactNode => {
    const visibleChildren = (childrenByParentId.get(node.id) ?? []).filter((child) =>
      visibleNodeIds.has(child.id)
    );

    if (isBranchNode(node)) {
      const currentValue = answers[node.key];
      const branchValue = typeof currentValue === "boolean" ? currentValue : null;
      return (
        <div
          key={node.id}
          data-branch-card={node.key}
          className={cn(
            "space-y-3 rounded-lg border p-4",
            depth > 0 && "border-dashed bg-muted/20"
          )}
        >
          <div className="space-y-1">
            <QuestionLabel htmlFor={`${node.key}-branch`} required={node.isRequired}>
              {node.label}
            </QuestionLabel>
            {node.prompt ? <p className="text-sm text-muted-foreground">{node.prompt}</p> : null}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              { value: true, label: "Yes" },
              { value: false, label: "No" },
            ].map((option) => {
              const selected = branchValue === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  data-branch-choice={`${node.key}:${option.label.toLowerCase()}`}
                  aria-pressed={selected}
                  className={cn(
                    "rounded-md border p-3 text-left text-sm transition-colors",
                    selected
                      ? "border-pink-500 bg-pink-500 text-white"
                      : "border-border bg-background hover:border-pink-200"
                  )}
                  onClick={() =>
                    onAnswerChange(node.key, branchValue === option.value ? null : option.value)
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {branchValue === true && visibleChildren.length > 0 ? (
            <div className="space-y-3">
              {visibleChildren.map((child) => renderNodeTree(child, depth + 1))}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div key={node.id} className="space-y-3">
        {renderQuestion(node, { nested: depth > 0 })}
        {visibleChildren.length > 0 ? (
          <div className={cn("space-y-3", depth > 0 && "border-l pl-4")}>
            {visibleChildren.map((child) => renderNodeTree(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  const activeScopeGroup = scopeGroups.find((group) => group.key === activeScopeGroupKey) ?? null;
  const activeScopeContentNodes = useMemo(() => {
    if (!activeScopeGroup?.appliesNode) return [];
    return activeScopeGroup.nodes
      .filter((node) => node.parentNodeId === activeScopeGroup.appliesNode?.id)
      .filter((node) => visibleNodeIds.has(node.id))
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }, [activeScopeGroup, visibleNodeIds]);
  const activeBranchNodes = activeScopeContentNodes.filter(isBranchNode);
  const activeRegularNodes = activeScopeContentNodes.filter((node) => !isBranchNode(node));

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
          <LeadScopeCardGrid
            items={scopeCardItems}
            selectedIds={selectedScopeIds}
            activeId={activeScopeGroupKey}
            onSelect={toggleScopeSelection}
            onActivate={activateScope}
          />
          {activeScopeGroup ? (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Selected scope
                </p>
                <h4 className="text-lg font-semibold">{activeScopeGroup.label}</h4>
              </div>
              {activeBranchNodes.length > 0 ? (
                <div className="space-y-3">
                  <p className="text-sm font-medium">Branch details</p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {activeBranchNodes.map((node) => renderNodeTree(node))}
                  </div>
                </div>
              ) : null}
              {activeRegularNodes.length > 0 ? (
                <div className="space-y-3">
                  {activeRegularNodes.map((node) => renderNodeTree(node))}
                </div>
              ) : null}
            </div>
          ) : null}
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
