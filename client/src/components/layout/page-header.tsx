import type { ReactElement, ReactNode } from "react";

type PageHeaderActions = {
  primary?: ReactNode;
  secondaryAction?: ReactElement;
  overflow?: ReactNode;
};

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  meta?: string;
  actions?: PageHeaderActions;
  secondaryRow?: ReactNode;
};

export function PageHeader({
  eyebrow,
  title,
  description,
  meta,
  actions,
  secondaryRow,
}: PageHeaderProps) {
  return (
    <section className="space-y-3" data-testid="page-header">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          {eyebrow ? (
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
          {meta ? <p className="text-sm text-muted-foreground">{meta}</p> : null}
        </div>

        {actions?.primary || actions?.secondaryAction ? (
          <div
            className="flex flex-wrap items-start gap-2 lg:max-w-[22rem] lg:justify-end"
            data-slot="page-header-actions"
          >
            {actions.primary}
            {actions.secondaryAction}
          </div>
        ) : null}
      </div>

      {actions?.overflow || secondaryRow ? (
        <div className="flex flex-wrap items-center gap-2" data-slot="page-header-secondary-row">
          {secondaryRow}
          {actions?.overflow}
        </div>
      ) : null}
    </section>
  );
}
