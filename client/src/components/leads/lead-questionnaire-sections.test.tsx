/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadQuestionnaireSections } from "./lead-questionnaire-sections";
import { sanitizeQuestionAnswerForSave } from "./questionnaire-answer-normalization";
import type { LeadQuestionnaireNode } from "@/hooks/use-leads";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SelectContext = React.createContext<{
  items?: Array<{ value: string | null; label?: React.ReactNode }>;
  value?: string;
  onValueChange?: (value: string) => void;
}>({});

function collectSelectItems(
  children: React.ReactNode,
  acc: Array<{ value: string | null; label?: React.ReactNode }> = []
): Array<{ value: string | null; label?: React.ReactNode }> {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      return;
    }

    const childProps = child.props as { value?: string | null; children?: React.ReactNode };
    if (Object.prototype.hasOwnProperty.call(childProps, "value")) {
      acc.push({
        value: childProps.value ?? null,
        label: childProps.children,
      });
    }

    if (childProps.children) {
      collectSelectItems(childProps.children, acc);
    }
  });

  return acc;
}

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    items,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    items?: Array<{ value: string | null; label?: React.ReactNode }>;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <SelectContext.Provider value={{ items: items ?? collectSelectItems(children), value, onValueChange }}>
      <div data-select-value={value ?? "__undefined__"}>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({ children, id }: { children: React.ReactNode; id?: string }) => <div id={id}>{children}</div>,
  SelectValue: ({ placeholder }: { children?: React.ReactNode; placeholder?: string }) => {
    const { value } = React.useContext(SelectContext);
    return <span data-select-label="true">{value ?? placeholder}</span>;
  },
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
    const { onValueChange } = React.useContext(SelectContext);
    return (
      <button type="button" data-value={value} onClick={() => onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

function makeQuestionNode(
  overrides: Partial<LeadQuestionnaireNode> & Pick<LeadQuestionnaireNode, "id" | "key" | "label">
): LeadQuestionnaireNode {
  return {
    projectTypeId: null,
    parentNodeId: null,
    parentOptionValue: null,
    nodeType: "question",
    prompt: null,
    inputType: "text",
    options: [],
    isRequired: false,
    displayOrder: 100,
    sectionKey: "baseline",
    groupKey: "baseline",
    groupLabel: "Universal Baseline",
    groupOrder: 0,
    isActive: true,
    ...overrides,
  };
}

describe("LeadQuestionnaireSections", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
  });

  it("renders placeholder text instead of a stored __unanswered__ dropdown value", () => {
    root = createRoot(container);
    act(() => {
      root.render(
        <LeadQuestionnaireSections
          nodes={[
            makeQuestionNode({
              id: "market-type",
              key: "market_type",
              label: "Market Type",
              inputType: "select",
              options: [{ value: "conventional", label: "Conventional" }],
            }),
          ]}
          answers={{ market_type: "__unanswered__" }}
          onAnswerChange={() => {}}
        />
      );
    });

    expect(container.textContent).not.toContain("__unanswered__");
    expect(container.querySelector('[data-select-label="true"]')?.textContent).toBe("Select");
  });

  it("forces Life Safety through the yes/no control even when metadata is stale", () => {
    root = createRoot(container);
    act(() => {
      root.render(
        <LeadQuestionnaireSections
          nodes={[
            makeQuestionNode({
              id: "life-safety",
              key: "life_safety",
              label: "Life Safety",
              inputType: "textarea",
            }),
          ]}
          answers={{}}
          onAnswerChange={() => {}}
        />
      );
    });

    const lifeSafety = container.querySelector('[data-question-key="life_safety"]');
    expect(lifeSafety?.textContent).toContain("Yes");
    expect(lifeSafety?.textContent).toContain("No");
  });

  it("normalizes __unanswered__ dropdown values to null before save", () => {
    const node = makeQuestionNode({
      id: "market-type",
      key: "market_type",
      label: "Market Type",
      inputType: "select",
      options: [{ value: "conventional", label: "Conventional" }],
    });

    expect(sanitizeQuestionAnswerForSave(node, "__unanswered__")).toBeNull();
  });
});
