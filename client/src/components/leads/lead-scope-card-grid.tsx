import { useMemo, useRef } from "react";
import type { KeyboardEvent } from "react";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LeadScopeCardItem {
  id: string;
  label: string;
  status: string;
  answeredCount: number;
}

interface LeadScopeCardGridProps {
  items: LeadScopeCardItem[];
  selectedIds: Set<string>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
}

export function LeadScopeCardGrid({
  items,
  selectedIds,
  activeId,
  onSelect,
  onActivate,
}: LeadScopeCardGridProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const itemIndexById = useMemo(
    () => new Map(items.map((item, index) => [item.id, index])),
    [items]
  );

  const focusCardAt = (nextIndex: number) => {
    const clamped = Math.max(0, Math.min(items.length - 1, nextIndex));
    buttonRefs.current[clamped]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, itemId: string) => {
    const index = itemIndexById.get(itemId);
    if (index == null) return;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusCardAt(index + 1);
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusCardAt(index - 1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusCardAt(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusCardAt(items.length - 1);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const selected = selectedIds.has(itemId);
      const active = activeId === itemId;
      if (selected && !active) {
        onActivate(itemId);
        return;
      }
      onSelect(itemId);
    }
  };

  return (
    <div
      role="listbox"
      aria-label="Scope groups"
      aria-multiselectable="true"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3"
    >
      {items.map((item, index) => {
        const selected = selectedIds.has(item.id);
        const active = activeId === item.id;
        return (
          <button
            key={item.id}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            type="button"
            role="option"
            data-scope-card={item.id}
            data-scope-active={active ? "true" : undefined}
            aria-selected={selected}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-28 flex-col items-start justify-between rounded-lg border p-4 text-left transition-all",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              selected
                ? "border-pink-500 bg-pink-500 text-white shadow-sm"
                : "border-border bg-background hover:border-pink-200 hover:shadow-sm",
              active && "ring-2 ring-pink-300 ring-offset-2"
            )}
            onClick={() => {
              if (selected && !active) {
                onActivate(item.id);
                return;
              }
              onSelect(item.id);
            }}
            onKeyDown={(event) => handleKeyDown(event, item.id)}
          >
            <div className="flex w-full items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold">{item.label}</p>
                <p
                  className={cn(
                    "text-xs",
                    selected ? "text-pink-50" : "text-muted-foreground"
                  )}
                >
                  {item.status}
                </p>
              </div>
              {selected ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
            </div>
            <span
              className={cn(
                "text-xs",
                selected ? "text-pink-100" : "text-muted-foreground"
              )}
            >
              {item.answeredCount > 0 ? `${item.answeredCount} answered` : "No answers yet"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
