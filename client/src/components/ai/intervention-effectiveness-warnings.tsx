import { Link } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { InterventionOutcomeEffectiveness } from "@/hooks/use-ai-ops";

function formatPercent(value: number | null) {
  if (value === null) return "n/a";
  return `${Math.round(value * 100)}%`;
}

export function InterventionEffectivenessWarnings(props: {
  warnings: InterventionOutcomeEffectiveness["warnings"];
}) {
  return (
    <Card className="border-border/80 bg-white shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" />
          Operational Warnings
        </CardTitle>
      </CardHeader>
      <CardContent>
        {props.warnings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No high-risk conclusion patterns are active.
          </div>
        ) : (
          <div className="space-y-3">
            {props.warnings.map((warning) => (
              <Link
                key={`${warning.kind}:${warning.key}`}
                to={warning.queueLink}
                className="block rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 transition-colors hover:border-amber-300"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-amber-950">{warning.label}</div>
                    <div className="mt-1 text-xs uppercase tracking-widest text-amber-800">
                      {warning.kind.replace(/_/g, " ")}
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-amber-950">{formatPercent(warning.rate)}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
