import type { MouseEvent, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

interface PipelineStagePageHeaderProps {
  backTo: string;
  title: string;
  subtitle?: string;
  summary?: ReactNode;
  children: ReactNode;
}

/**
 * True when there is an in-app history entry to step back to (a real drill-down referrer), so the Back
 * control can return the user to the view they came FROM (rep detail, director dashboard, pipeline, the
 * board, …) instead of always jumping to the fixed `backTo` board URL.
 *
 * react-router (v7) stamps a monotonic `idx` into window.history.state: a fresh session / deep link / hard
 * refresh starts at idx 0, every push increments it, and an in-place <Navigate replace> (which the stage
 * page fires on mount to normalize scope / translate bare params) PRESERVES it. So `idx > 0` reliably means
 * "navigated here from somewhere in the app" even after those mount redirects, while a directly-opened
 * cohort URL stays at idx 0 and correctly falls back to the board. Guarded for SSR where window is absent.
 */
function hasInAppReferrer(): boolean {
  if (typeof window === "undefined") return false;
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && idx > 0;
}

export function PipelineStagePageHeader({
  backTo,
  title,
  subtitle,
  summary,
  children,
}: PipelineStagePageHeaderProps) {
  const navigate = useNavigate();

  // The Back control stays an anchor pointing at `backTo` (so middle-click / open-in-new-tab and the
  // deep-link / no-referrer case all resolve to a real board URL), but a plain left-click steps back
  // through history when the user drilled in from elsewhere — returning to the ACTUAL previous view with
  // its filters/scope intact, rather than discarding the drill path and dumping them on the board.
  const handleBackClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented) return;
    // Leave modified / non-primary clicks to the browser (open in new tab/window).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!hasInAppReferrer()) return; // deep link / fresh load → follow the href to `backTo`
    event.preventDefault();
    navigate(-1);
  };

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
        <div className="space-y-4 px-7 pb-6 pt-7">
          <Link
            to={backTo}
            onClick={handleBackClick}
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 transition-colors hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
          <div className="space-y-2">
            <h1 className="text-[2.35rem] leading-none font-black tracking-tight text-slate-950">{title}</h1>
            {subtitle ? <p className="text-sm text-slate-500">{subtitle}</p> : null}
          </div>
        </div>
        {summary ? (
          <div className="grid gap-4 border-t border-slate-200 bg-[#f7f8fb] px-7 py-5 md:grid-cols-3">{summary}</div>
        ) : null}
      </section>
      <div className="overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white shadow-sm">
        <div className="px-4 py-4 md:px-6">
          {children}
        </div>
      </div>
    </div>
  );
}
