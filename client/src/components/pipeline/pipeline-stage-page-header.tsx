import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

interface PipelineStagePageHeaderProps {
  backTo: string;
  title: string;
  subtitle?: string;
  summary?: ReactNode;
  children: ReactNode;
}

export function PipelineStagePageHeader({
  backTo,
  title,
  subtitle,
  summary,
  children,
}: PipelineStagePageHeaderProps) {
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
        <div className="space-y-4 px-7 pb-6 pt-7">
          <Link
            to={backTo}
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 transition-colors hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to board
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
