import { Link } from "react-router-dom";
import type { InterventionManagerBrief as InterventionManagerBriefData } from "@/hooks/use-ai-ops";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function BriefItem({
  text,
  queueLink,
  searchParams,
}: {
  text: string;
  queueLink: string | null;
  searchParams: URLSearchParams;
}) {
  const href = appendDisconnectContextToHref(queueLink, searchParams);
  if (!href) return <span>{text}</span>;

  return (
    <Link to={href} className="font-medium text-gray-900 underline decoration-border underline-offset-4 hover:text-brand-red">
      {text}
    </Link>
  );
}

function appendDisconnectContextToHref(path: string | null, searchParams: URLSearchParams) {
  if (!path) return path;

  const url = new URL(path, "https://manager-brief.local");
  const nextSearchParams = new URLSearchParams(url.search);
  for (const key of ["type", "cluster", "trend"] as const) {
    const value = searchParams.get(key);
    if (value) nextSearchParams.set(key, value);
  }

  const nextQuery = nextSearchParams.toString();
  return `${url.pathname}${nextQuery ? `?${nextQuery}` : ""}${url.hash}`;
}

export function InterventionManagerBrief({
  brief,
  searchParams,
}: {
  brief: InterventionManagerBriefData;
  searchParams: URLSearchParams;
}) {
  const isFallback =
    brief.whatChanged.length === 0 &&
    brief.focusNow.length === 0 &&
    brief.emergingPatterns.length === 0;

  return (
    <Card className="border-border/80 bg-white shadow-sm">
      <CardHeader className="space-y-2">
        <CardTitle>Manager Brief</CardTitle>
        <CardDescription>{brief.summaryWindowLabel}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {brief.error && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {brief.groundingNote}
          </div>
        )}

        <div className="rounded-xl border border-border/80 bg-muted/20 px-4 py-4">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Headline</div>
          <p className="mt-2 text-base font-semibold text-gray-900">{brief.headline}</p>
        </div>

        {!isFallback && (
          <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
            <section className="rounded-xl border border-border/80 bg-white px-4 py-4">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">What Changed</div>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                {brief.whatChanged.map((item) => (
                  <li key={item.key}>
                    <BriefItem text={item.text} queueLink={item.queueLink} searchParams={searchParams} />
                  </li>
                ))}
              </ul>
            </section>

            <section className="rounded-xl border border-border/80 bg-white px-4 py-4">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Focus Now</div>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                {brief.focusNow.map((item) => (
                  <li key={item.key}>
                    <BriefItem text={item.text} queueLink={item.queueLink} searchParams={searchParams} />
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}

        {brief.emergingPatterns.length > 0 && (
          <section className="space-y-3">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Emerging Patterns</div>
            <div className="grid gap-3 xl:grid-cols-3">
              {brief.emergingPatterns.slice(0, 3).map((item) => {
                const body = (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="font-semibold text-gray-900">{item.title}</h3>
                      <span className="rounded-full border border-border bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-gray-700">
                        {item.confidence}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.summary}</p>
                  </>
                );

                const href = appendDisconnectContextToHref(item.queueLink, searchParams);

                return href ? (
                  <Link
                    key={item.key}
                    to={href}
                    className="block rounded-xl border border-border/80 bg-white px-4 py-4 shadow-sm transition-transform hover:-translate-y-0.5 hover:border-brand-red/30"
                  >
                    {body}
                  </Link>
                ) : (
                  <div key={item.key} className="rounded-xl border border-border/80 bg-white px-4 py-4 shadow-sm">
                    {body}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {isFallback && (
          <div className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
            {brief.headline}
          </div>
        )}

        <div className="text-xs leading-5 text-muted-foreground">{brief.groundingNote}</div>
      </CardContent>
    </Card>
  );
}
