import { Download, Loader2 } from "lucide-react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { Button, Panel } from "../components/ui";
import { useAdminProgressUser, useMe } from "../hooks/use-cleanup";

function canUseAdminTools(role?: string) {
  return role === "admin" || role === "director";
}

function formatDate(value?: string | null) {
  if (!value) return "No activity";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function fieldChanges(value: unknown) {
  return Array.isArray(value) ? value as Array<{ field?: string; before?: unknown; after?: unknown }> : [];
}

function actionLabel(action: string, metadata: unknown) {
  if (action === "skipped" && metadata && typeof metadata === "object" && "reason" in metadata) {
    return `skipped: ${String((metadata as { reason?: unknown }).reason ?? "")}`;
  }
  return action.split("_").join(" ");
}

export function AdminProgressDetailPage() {
  const { userId } = useParams();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page") ?? "1"));
  const { data: user, isLoading: userLoading } = useMe();
  const adminEnabled = canUseAdminTools(user?.role);
  const detail = useAdminProgressUser(userId, page, adminEnabled);

  if (userLoading) {
    return (
      <main className="grid min-h-[80vh] place-items-center">
        <Loader2 className="h-7 w-7 animate-spin text-red-700" />
      </main>
    );
  }
  if (!adminEnabled) return <Navigate to="/cleanup" replace />;

  const data = detail.data;
  const exportBase = `/api/cleanup/admin/progress/user/${userId}/export`;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
      {detail.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-stone-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading rep activity
        </div>
      ) : data ? (
        <>
          <div className="flex flex-col gap-4 border-b border-stone-300 pb-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-bold uppercase tracking-wide text-red-800">Rep detail</p>
              <h1 className="mt-2 text-3xl font-black text-stone-950">{data.user.displayName}</h1>
              <p className="mt-1 text-sm text-stone-600">{data.user.email} · {data.user.role}</p>
            </div>
            <div className="flex gap-2">
              <a href={`${exportBase}?format=csv`}>
                <Button variant="secondary">
                  <Download className="h-4 w-4" />
                  CSV
                </Button>
              </a>
              <a href={`${exportBase}?format=json`}>
                <Button variant="secondary">JSON</Button>
              </a>
            </div>
          </div>

          <section className="mt-6 grid gap-3 md:grid-cols-4">
            {[
              ["Total assigned", data.stats.total],
              ["Completed", data.stats.completed],
              ["Skipped", data.stats.skipped],
              ["Remaining", data.stats.remaining],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-stone-300 bg-stone-50 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{label}</p>
                <p className="mt-2 text-3xl font-black tabular-nums text-stone-950">{value}</p>
              </div>
            ))}
          </section>

          <Panel className="mt-5 p-5">
            <div className="grid gap-3 text-sm text-stone-700 md:grid-cols-3">
              <p><span className="font-bold text-stone-950">% Done:</span> {data.stats.percentDone}%</p>
              <p><span className="font-bold text-stone-950">First action:</span> {formatDate(data.stats.firstActionAt)}</p>
              <p><span className="font-bold text-stone-950">Most recent:</span> {formatDate(data.stats.lastActionAt)}</p>
            </div>
          </Panel>

          <Panel className="mt-6 overflow-hidden">
            <div className="border-b border-stone-300 bg-stone-200 px-4 py-3">
              <h2 className="font-black text-stone-950">Activity feed</h2>
            </div>
            {data.activity.entries.length === 0 ? (
              <div className="p-6 text-sm text-stone-600">No cleanup activity has been recorded for this user.</div>
            ) : (
              data.activity.entries.map((entry) => (
                <div key={`${entry.timestamp}-${entry.recordId}-${entry.action}`} className="border-b border-stone-200 px-4 py-4 last:border-0">
                  <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="font-bold text-stone-950">{entry.recordName}</p>
                      <p className="text-sm text-stone-600">{entry.recordType} · {actionLabel(entry.action, entry.metadata)} · {entry.source}</p>
                    </div>
                    <p className="text-sm text-stone-600">{formatDate(entry.timestamp)}</p>
                  </div>
                  {fieldChanges(entry.fieldChanges).length > 0 ? (
                    <div className="mt-3 overflow-x-auto">
                      <table className="min-w-full text-left text-xs">
                        <thead className="text-stone-500">
                          <tr>
                            <th className="py-1 pr-4">Field</th>
                            <th className="py-1 pr-4">Before</th>
                            <th className="py-1 pr-4">After</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fieldChanges(entry.fieldChanges).map((change, index) => (
                            <tr key={`${change.field}-${index}`} className="border-t border-stone-200">
                              <td className="py-1 pr-4 font-semibold text-stone-800">{change.field}</td>
                              <td className="py-1 pr-4 text-stone-600">{String(change.before ?? "")}</td>
                              <td className="py-1 pr-4 text-stone-950">{String(change.after ?? "")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </Panel>

          <div className="mt-4 flex items-center justify-between">
            <Button variant="secondary" disabled={page === 1} onClick={() => setParams({ page: String(Math.max(1, page - 1)) })}>Previous</Button>
            <span className="text-sm text-stone-600">Page {page}</span>
            <Button variant="secondary" disabled={data.activity.entries.length < data.activity.pageSize} onClick={() => setParams({ page: String(page + 1) })}>Next</Button>
          </div>
        </>
      ) : null}
    </main>
  );
}
