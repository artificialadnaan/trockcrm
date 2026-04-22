import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface PipelineStagePageHeaderProps {
  backTo: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function PipelineStagePageHeader({
  backTo,
  title,
  subtitle,
  children,
}: PipelineStagePageHeaderProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link to={backTo} className="text-sm font-medium text-slate-500 hover:text-slate-900">
          Back to board
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{title}</h1>
          {subtitle ? <p className="text-sm text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </div>
  );
}
