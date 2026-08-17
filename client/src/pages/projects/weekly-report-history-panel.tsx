import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  fetchWeeklyReportDetail,
  useWeeklyReportHistory,
  type WeeklyReportDetail,
  type WeeklyReportProject,
} from "@/hooks/use-weekly-reports";

const STATUS_BADGE: Record<string, string> = {
  draft: "border-amber-200 bg-amber-50 text-amber-700",
  pending_review: "border-blue-200 bg-blue-50 text-blue-700",
  approved: "border-violet-200 bg-violet-50 text-violet-700",
  sent: "border-emerald-200 bg-emerald-50 text-emerald-700",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "With super",
  pending_review: "Pending PM review",
  approved: "Approved, not sent",
  sent: "Sent",
};

function fmtWeek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

export function WeeklyReportHistoryPanel({ projects }: { projects: WeeklyReportProject[] }) {
  const [projectId, setProjectId] = useState<string>("");

  // Default to the first project once the list arrives, so the tab isn't an empty prompt on open.
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const { reports, loading, error } = useWeeklyReportHistory(projectId || null);
  const [detail, setDetail] = useState<WeeklyReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const selected = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  const openDetail = async (reportId: string) => {
    setDetailLoading(true);
    try {
      setDetail(await fetchWeeklyReportDetail(reportId));
    } finally {
      setDetailLoading(false);
    }
  };

  if (projects.length === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-[13.5px] font-semibold text-slate-500">
        <CalendarClock className="h-4 w-4 text-slate-400" />
        Add a weekly report project first — history appears here once reports start going out.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Project</span>
        <select
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          aria-label="Project"
          className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[13px] font-semibold text-slate-700"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.propertyDisplayName ?? project.dealName ?? "Untitled project"}
            </option>
          ))}
        </select>
        {selected?.clientName && (
          <span className="text-[12.5px] font-semibold text-slate-400">for {selected.clientName}</span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-[13.5px] font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> Loading history…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-[13.5px] font-semibold text-slate-500">
          <AlertTriangle className="h-4 w-4 text-brand-red" /> {error}
        </div>
      ) : reports.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-[13.5px] font-semibold text-slate-500">
          <CalendarClock className="h-4 w-4 text-slate-400" /> No reports yet for this project.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="border-b border-slate-200 bg-slate-50/70">
              <tr>
                <Th>Week of</Th>
                <Th>Status</Th>
                <Th>Author</Th>
                <Th className="text-right">Completion</Th>
                <Th className="text-right">Photos</Th>
                <Th className="text-right" />
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3.5 py-3 font-semibold text-slate-900">
                    {fmtWeek(report.weekOf)}
                    {report.version > 1 && (
                      <span className="ml-1.5 text-[10.5px] font-bold uppercase tracking-wide text-violet-600">
                        v{report.version}
                      </span>
                    )}
                  </td>
                  <td className="px-3.5 py-3">
                    <Badge variant="outline" className={`${STATUS_BADGE[report.status] ?? ""} whitespace-nowrap`}>
                      {STATUS_LABEL[report.status] ?? report.status}
                    </Badge>
                  </td>
                  <td className="px-3.5 py-3 text-slate-600">{report.authoredByName ?? "—"}</td>
                  <td className="px-3.5 py-3 text-right tabular-nums text-slate-700">
                    {report.completionPercent == null ? "—" : `${report.completionPercent}%`}
                  </td>
                  <td className="px-3.5 py-3 text-right tabular-nums text-slate-500">{report.photos.length || "—"}</td>
                  <td className="px-3.5 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => void openDetail(report.id)}
                      className="rounded-lg border border-slate-200 px-2.5 py-1 text-[12.5px] font-semibold text-slate-600 hover:border-brand-red hover:text-brand-red"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={Boolean(detail) || detailLoading} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{detail ? `Week of ${fmtWeek(detail.weekOf)}` : "Loading…"}</SheetTitle>
          </SheetHeader>
          {detailLoading && !detail ? (
            <div className="flex items-center gap-2 p-4 text-[13.5px] text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
            </div>
          ) : detail ? (
            <div className="space-y-4 p-4">
              <Section title="Work Completed / In-Progress" body={detail.workCompleted} />
              <Section title="Next Week Look Ahead" body={detail.nextWeekLookAhead} />
              <Section title="Issues / Concerns" body={detail.issuesConcerns} />
              <div className="grid grid-cols-3 gap-3">
                <Metric label="Completion" value={detail.completionPercent == null ? "—" : `${detail.completionPercent}%`} />
                <Metric label="Weather delays" value={detail.weatherDelayDays == null ? "—" : `${detail.weatherDelayDays}d`} />
                <Metric label="Weeks remaining" value={detail.remainingWeeks == null ? "—" : String(detail.remainingWeeks)} />
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Photos ({detail.photos.length})
                </p>
                {detail.photos.length === 0 ? (
                  <p className="text-[13px] text-slate-400">No photos on this report.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.photos.map((photo) => (
                      <li key={photo.fileId} className="rounded-lg border border-slate-200 px-2.5 py-2 text-[13px]">
                        {photo.caption ?? <span className="text-slate-400">No caption</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Section({ title, body }: { title: string; body: string | null }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">{title}</p>
      <p className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[13px] text-slate-700">
        {body ?? "—"}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-0.5 text-[16px] font-black tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-3.5 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-slate-400 ${className}`}
    >
      {children}
    </th>
  );
}
