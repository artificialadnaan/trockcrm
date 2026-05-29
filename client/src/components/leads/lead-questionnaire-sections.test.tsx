/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadQuestionnaireSections } from "./lead-questionnaire-sections";
import { CLEAR_SELECTION_VALUE, sanitizeQuestionAnswerForSave } from "./questionnaire-answer-normalization";
import type { LeadAnswerValue, LeadQuestionnaireNode } from "@/hooks/use-leads";

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

function accessQuestionNodes() {
  return [
    makeQuestionNode({
      id: "site-access",
      key: "site_access",
      label: "Access",
      inputType: "textarea",
      sectionKey: "property",
      groupKey: "property",
      groupLabel: "Property/Building Info",
      displayOrder: 1300,
      isRequired: true,
    }),
    makeQuestionNode({
      id: "site-access-other-detail",
      key: "site_access_other_detail",
      label: "Type of access detail",
      inputType: "text",
      sectionKey: "property",
      groupKey: "property",
      groupLabel: "Property/Building Info",
      displayOrder: 1310,
      isRequired: true,
      parentNodeId: "site-access",
      parentOptionValue: "Other",
    }),
  ];
}

describe("LeadQuestionnaireSections", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
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

  it("lets optional dropdowns clear back to an empty value", () => {
    const onAnswerChange = vi.fn();

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
              isRequired: false,
            }),
          ]}
          answers={{ market_type: "conventional" }}
          onAnswerChange={onAnswerChange}
        />
      );
    });

    const clearButton = container.querySelector<HTMLButtonElement>(`button[data-value="${CLEAR_SELECTION_VALUE}"]`);
    expect(clearButton?.textContent).toContain("no selection");

    act(() => {
      clearButton?.click();
    });

    expect(onAnswerChange).toHaveBeenCalledWith("market_type", null);
  });

  it("does not render a clear option for required yes/no questions", () => {
    root = createRoot(container);
    act(() => {
      root.render(
        <LeadQuestionnaireSections
          nodes={[
            makeQuestionNode({
              id: "life-safety",
              key: "life_safety",
              label: "Life Safety",
              inputType: "boolean",
              isRequired: true,
            }),
          ]}
          answers={{}}
          onAnswerChange={() => {}}
        />
      );
    });

    expect(container.querySelector(`button[data-value="${CLEAR_SELECTION_VALUE}"]`)).toBeNull();
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

  it("normalizes clear sentinel values to null before save", () => {
    const node = makeQuestionNode({
      id: "life-safety",
      key: "life_safety",
      label: "Life Safety",
      inputType: "boolean",
    });

    expect(sanitizeQuestionAnswerForSave(node, CLEAR_SELECTION_VALUE)).toBeNull();
  });

  it("renders Type of access as a dropdown with four options and reveals the detail field for Other", () => {
    root = createRoot(container);
    act(() => {
      root.render(
        <LeadQuestionnaireSections
          nodes={accessQuestionNodes()}
          answers={{ site_access: "Other", site_access_other_detail: "Gate code required" }}
          onAnswerChange={() => {}}
        />
      );
    });

    const accessQuestion = container.querySelector('[data-question-key="site_access"]');
    expect(accessQuestion?.textContent).toContain("Type of access");
    expect(accessQuestion?.textContent).toContain("Gated");
    expect(accessQuestion?.textContent).toContain("Not Gated");
    // Label-only relabel (#5): the option DISPLAYS "Fobbed" but still STORES the
    // value "Bobbed". Migration 0130 and isTypeOfAccessOption continue to key off
    // "Bobbed", so existing leads with site_access == "Bobbed" must be unaffected.
    expect(accessQuestion?.textContent).toContain("Fobbed");
    expect(accessQuestion?.textContent).not.toContain("Bobbed");
    expect(accessQuestion?.querySelector('button[data-value="Bobbed"]')?.textContent).toBe("Fobbed");
    expect(accessQuestion?.textContent).toContain("Other");
    expect(container.querySelector<HTMLInputElement>("#site_access_other_detail")?.value).toBe("Gate code required");
  });

  it("renders scope groups as selectable cards instead of accordion rows", () => {
    root = createRoot(container);
    act(() => {
      root.render(
        <LeadQuestionnaireSections
          nodes={[
            makeQuestionNode({
              id: "roofing-applies",
              key: "roofing_applies",
              label: "Does roofing scope apply?",
              inputType: "boolean",
              sectionKey: "scope",
              groupKey: "roofing",
              groupLabel: "Roofing",
              groupOrder: 1,
              displayOrder: 0,
            }),
            makeQuestionNode({
              id: "balconies-applies",
              key: "balconies_applies",
              label: "Does balcony scope apply?",
              inputType: "boolean",
              sectionKey: "scope",
              groupKey: "balconies",
              groupLabel: "Balconies",
              groupOrder: 2,
              displayOrder: 0,
            }),
          ]}
          answers={{}}
          onAnswerChange={() => {}}
        />
      );
    });

    expect(container.querySelectorAll("[data-scope-card]")).toHaveLength(2);
    expect(container.querySelector("[data-scope-group]")).toBeNull();
    expect(container.querySelector('[role="listbox"]')?.className).toContain("grid-cols-1");
    expect(container.querySelector('[role="listbox"]')?.className).toContain("sm:grid-cols-2");
    expect(container.querySelector('[role="listbox"]')?.className).toContain("md:grid-cols-3");
  });

  it("shows child branch nodes as branch cards inside the active scope panel", () => {
    root = createRoot(container);
    act(() => {
      root.render(
        <LeadQuestionnaireSections
          nodes={[
            makeQuestionNode({
              id: "roofing-applies",
              key: "roofing_applies",
              label: "Does roofing scope apply?",
              inputType: "boolean",
              sectionKey: "scope",
              groupKey: "roofing",
              groupLabel: "Roofing",
              groupOrder: 1,
              displayOrder: 0,
            }),
            makeQuestionNode({
              id: "roofing-insurance",
              key: "roofing_insurance_claim",
              label: "Insurance Claim",
              inputType: "boolean",
              sectionKey: "scope",
              groupKey: "roofing",
              groupLabel: "Roofing",
              groupOrder: 1,
              displayOrder: 1,
              parentNodeId: "roofing-applies",
              parentOptionValue: "true",
            }),
            makeQuestionNode({
              id: "roofing-xactimate",
              key: "roofing_xactimate",
              label: "Xactimate",
              inputType: "boolean",
              sectionKey: "scope",
              groupKey: "roofing",
              groupLabel: "Roofing",
              groupOrder: 1,
              displayOrder: 2,
              parentNodeId: "roofing-insurance",
              parentOptionValue: "true",
            }),
          ]}
          answers={{ roofing_applies: true }}
          onAnswerChange={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-branch-card="roofing_insurance_claim"]')).toBeTruthy();
  });

  it("renders all selected scope panels simultaneously while keeping one active card", () => {
    root = createRoot(container);
    act(() => {
      root.render(
        <LeadQuestionnaireSections
          nodes={[
            makeQuestionNode({
              id: "roofing-applies",
              key: "roofing_applies",
              label: "Does roofing scope apply?",
              inputType: "boolean",
              sectionKey: "scope",
              groupKey: "roofing",
              groupLabel: "Roofing",
              groupOrder: 1,
              displayOrder: 0,
            }),
            makeQuestionNode({
              id: "roof-type",
              key: "roof_type",
              label: "Roof Type",
              inputType: "text",
              sectionKey: "scope",
              groupKey: "roofing",
              groupLabel: "Roofing",
              groupOrder: 1,
              displayOrder: 1,
              parentNodeId: "roofing-applies",
              parentOptionValue: "true",
            }),
            makeQuestionNode({
              id: "balconies-applies",
              key: "balconies_applies",
              label: "Does balcony scope apply?",
              inputType: "boolean",
              sectionKey: "scope",
              groupKey: "balconies",
              groupLabel: "Balconies",
              groupOrder: 2,
              displayOrder: 0,
            }),
            makeQuestionNode({
              id: "balcony-type",
              key: "balcony_type",
              label: "Balcony Type",
              inputType: "text",
              sectionKey: "scope",
              groupKey: "balconies",
              groupLabel: "Balconies",
              groupOrder: 2,
              displayOrder: 1,
              parentNodeId: "balconies-applies",
              parentOptionValue: "true",
            }),
          ]}
          answers={{ roofing_applies: true, balconies_applies: true }}
          onAnswerChange={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-scope-panel="roofing"]')?.textContent).toContain("Roof Type");
    expect(container.querySelector('[data-scope-panel="balconies"]')?.textContent).toContain("Balcony Type");
  });

  it("scrolls when a scope card is activated but not when typing inside a selected panel", () => {
    function Harness() {
      const [answers, setAnswers] = React.useState<Record<string, LeadAnswerValue>>({});

      const handleAnswerChange = (key: string, value: LeadAnswerValue) => {
        setAnswers((current) => ({
          ...current,
          [key]: value,
        }));
      };

      return (
        <LeadQuestionnaireSections
          nodes={[
            makeQuestionNode({
              id: "roofing-applies",
              key: "roofing_applies",
              label: "Does roofing scope apply?",
              inputType: "boolean",
              sectionKey: "scope",
              groupKey: "roofing",
              groupLabel: "Roofing",
              groupOrder: 1,
              displayOrder: 0,
            }),
            makeQuestionNode({
              id: "roof-type",
              key: "roof_type",
              label: "Roof Type",
              inputType: "text",
              sectionKey: "scope",
              groupKey: "roofing",
              groupLabel: "Roofing",
              groupOrder: 1,
              displayOrder: 1,
              parentNodeId: "roofing-applies",
              parentOptionValue: "true",
            }),
            makeQuestionNode({
              id: "balconies-applies",
              key: "balconies_applies",
              label: "Does balcony scope apply?",
              inputType: "boolean",
              sectionKey: "scope",
              groupKey: "balconies",
              groupLabel: "Balconies",
              groupOrder: 2,
              displayOrder: 0,
            }),
            makeQuestionNode({
              id: "balcony-type",
              key: "balcony_type",
              label: "Balcony Type",
              inputType: "text",
              sectionKey: "scope",
              groupKey: "balconies",
              groupLabel: "Balconies",
              groupOrder: 2,
              displayOrder: 1,
              parentNodeId: "balconies-applies",
              parentOptionValue: "true",
            }),
          ]}
          answers={answers}
          onAnswerChange={handleAnswerChange}
        />
      );
    }

    root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });

    const roofingCard = container.querySelector<HTMLButtonElement>('[data-scope-card="roofing"]');
    const balconiesCard = container.querySelector<HTMLButtonElement>('[data-scope-card="balconies"]');

    expect(roofingCard).toBeTruthy();
    expect(balconiesCard).toBeTruthy();
    act(() => {
      roofingCard?.click();
    });
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

    const roofTypeInput = container.querySelector<HTMLInputElement>("#roof_type");
    expect(roofTypeInput).toBeTruthy();

    act(() => {
      roofTypeInput!.value = "Shingle";
      roofTypeInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

    act(() => {
      balconiesCard?.click();
    });
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
  });
});
