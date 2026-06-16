import { useState, type ComponentType } from "react";
import { Loader2 } from "lucide-react";
import { useMondayShowcase } from "@/hooks/use-reports";
import {
  SHOWCASE_VARIANTS,
  type ShowcaseVariantKey,
  type MondayShowcaseData,
  type EvidenceRequest,
} from "./monday-showcase/types";
import { DrillProvider } from "./monday-showcase/drill";
import { EvidenceDrawer } from "./monday-showcase/evidence-drawer";
import { DEFAULT_WEEK_MODE, WEEK_MODE_LABELS, type WeekMode } from "./week-mode";
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
  const [mode, setMode] = useState<WeekMode>(DEFAULT_WEEK_MODE);
  const [variant, setVariant] = useState<ShowcaseVariantKey>("HERO");
  const [evidence, setEvidence] = useState<EvidenceRequest | null>(null);
  const { data, loading, error, refetch } = useMondayShowcase(mode);
  const Active = VARIANT_COMPONENT[variant];

  // Deliberately NOT wrapped in ReportShell: this is a fixed weekly Monday view whose only control is the
  // WTD / last-full-week toggle below. It does not take a date range / office / owner filter, so it must
  // not render the shared Report Filters bar (a bar that doesn't filter is a UX trap).
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Reports · Monday showcase
          </p>
          <h1 className="text-2xl font-bold">Monday Showcase</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Many presentations, one source of truth — switch variants to compare layouts on identical
            numbers. Every number is evidence-backed: click it to see the exact records behind it. Fixed
            weekly view (use the toggle); the shared date/office/owner filter bar does not apply here.
          </p>
        </div>
        <button
          onClick={() => void refetch()}
          className="shrink-0 rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : data ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex overflow-hidden rounded-lg border">
              {(["to_date", "completed", "mtd", "ytd"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 text-sm ${mode === m ? "bg-foreground text-background" : "bg-white text-muted-foreground"}`}
                >
                  {WEEK_MODE_LABELS[m]}
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

          <DrillProvider open={setEvidence}>
            <div className="rounded-xl border bg-gray-50/50 p-4">
              <Active data={data} />
            </div>
          </DrillProvider>
          <p className="text-xs text-muted-foreground">
            Tip: most figures here are clickable — open the exact records behind a number. Many show a dotted
            underline; the headline tiles and hero numbers are clickable too.
          </p>

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Source notes &amp; value-basis discipline</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : (
        <div className="rounded-lg border bg-gray-50 p-6 text-sm text-muted-foreground">
          No showcase data for this period.
        </div>
      )}

      <EvidenceDrawer request={evidence} mode={mode} onClose={() => setEvidence(null)} />
    </div>
  );
}
