import { cn } from "@/lib/utils";
import type { WorkbenchPanelId } from "./estimating-workflow-shell";

export function EstimateWorkbenchSidebar({
  activePanel,
  onSelectPanel,
  steps,
}: {
  activePanel: WorkbenchPanelId;
  onSelectPanel: (panel: WorkbenchPanelId) => void;
  steps: Array<{
    id: WorkbenchPanelId;
    label: string;
    count?: number;
    detail: string;
  }>;
}) {
  return (
    <aside className="rounded-lg border bg-background">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Workbench Stages</h3>
        <p className="text-xs text-muted-foreground">Move through intake, review, and promotion without leaving the estimate tab.</p>
      </div>
      <nav className="p-2">
        {steps.map((step) => {
          const isActive = step.id === activePanel;

          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onSelectPanel(step.id)}
              className={cn(
                "flex w-full items-start justify-between rounded-md px-3 py-2 text-left transition-colors",
                isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              )}
            >
              <span>
                <span className="block text-sm font-medium">{step.label}</span>
                <span className="block text-xs">{step.detail}</span>
              </span>
              {typeof step.count === "number" ? (
                <span className="ml-3 text-xs font-medium">{step.count}</span>
              ) : null}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
