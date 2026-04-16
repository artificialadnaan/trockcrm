import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AiRiskFlag } from "@/hooks/use-ai-copilot";

interface BlindSpotCardProps {
  flag: AiRiskFlag;
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

export function BlindSpotCard({ flag }: BlindSpotCardProps) {
  const severityClass = SEVERITY_STYLES[flag.severity] ?? SEVERITY_STYLES.low;

  return (
    <div className="rounded-lg border border-border/80 bg-background px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-amber-100 p-1.5 text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium leading-5">{flag.title}</p>
            <Badge variant="outline" className={severityClass}>
              {flag.severity}
            </Badge>
          </div>
          {flag.details && (
            <p className="text-sm text-muted-foreground leading-5">{flag.details}</p>
          )}
        </div>
      </div>
    </div>
  );
}
