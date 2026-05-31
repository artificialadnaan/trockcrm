import { useState, type ComponentType } from "react";
import { useMondayShowcase } from "@/hooks/use-reports";
import { ReportShell } from "./sales-report-ui";
import { SHOWCASE_VARIANTS, type ShowcaseVariantKey, type MondayShowcaseData } from "./monday-showcase/types";
import {
  VariantA1Funnel,
  VariantA2Scoreboard,
  VariantA3Lanes,
  VariantExecHero,
  VariantB1Scorecards,
  VariantB2Leaderboard,
  VariantB3LoadLane,
  VariantB4ForecastLadder,
} from "./monday-showcase/variants";

const VARIANT_COMPONENT: Record<ShowcaseVariantKey, ComponentType<{ data: MondayShowcaseData }>> = {
  A1: VariantA1Funnel,
  A2: VariantA2Scoreboard,
  A3: VariantA3Lanes,
  HERO: VariantExecHero,
  B1: VariantB1Scorecards,
  B2: VariantB2Leaderboard,
  B3: VariantB3LoadLane,
  B4: VariantB4ForecastLadder,
};

export function MondayShowcasePage() {
  const [mode, setMode] = useState<"to_date" | "completed">("to_date");
  const [variant, setVariant] = useState<ShowcaseVariantKey>("HERO");
  const { data, loading, error, refetch } = useMondayShowcase(mode);
  const Active = VARIANT_COMPONENT[variant];

  return (
    <ReportShell
      eyebrow="Reports · Part 2 (Monday showcase)"
      title="Monday Showcase"
      description="Many presentations, one source of truth — switch variants to compare layouts on identical numbers."
      loading={loading}
      error={error}
      hasData={Boolean(data)}
      emptyText="No showcase data for this period."
      onRefresh={() => void refetch()}
    >
      {data ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex overflow-hidden rounded-lg border">
              {(["to_date", "completed"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 text-sm ${mode === m ? "bg-foreground text-background" : "bg-white text-muted-foreground"}`}
                >
                  {m === "to_date" ? "Week-to-date" : "Last full week"}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">Period: {data.period.label}</span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {SHOWCASE_VARIANTS.map((v) => (
              <button
                key={v.key}
                onClick={() => setVariant(v.key)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  variant === v.key ? "border-foreground bg-foreground text-background" : "bg-white text-muted-foreground hover:bg-gray-50"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>

          <div className="rounded-xl border bg-gray-50/50 p-4">
            <Active data={data} />
          </div>

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Source notes &amp; value-basis discipline</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </ReportShell>
  );
}
