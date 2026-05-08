import { Download, Loader2 } from "lucide-react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { Button, Panel, Select, TextInput } from "../components/ui";
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

function skipDetails(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return null;
  const value = metadata as { reason?: unknown; notes?: unknown };
  if (!value.reason && !value.notes) return null;
  return {
    reason: value.reason ? String(value.reason).replace(/_/g, " ") : "unspecified",
    notes: value.notes ? String(value.notes) : "",
  };
}

export function AdminProgressDetailPage() {
  const { userId } = useParams();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page") ?? "1"));
  const status = params.get("status") ?? "all";
  const q = params.get("q") ?? "";
  const { data: user, isLoading: userLoading } = useMe();
  const adminEnabled = canUseAdminTools(user?.role);
  const detail = useAdminProgressUser(userId, page, adminEnabled, { status, q });

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
  const groupedEntries = data?.activity.entries.reduce<Record<string, typeof data.activity.entries>>((acc, entry) => {
    const key = entry.recordType;
    acc[key] = acc[key] ?? [];
    acc[key].push(entry);
    return acc;
  }, {}) ?? {};
  const updateParams = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    Object.entries(next).forEach(([key, value]) => {
      if (!value || value === "all") merged.delete(key);
      else merged.set(key, value);
    });
    merged.set("page", "1");
    setParams(merged);
  };

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
            <div className="grid gap-3 border-b border-stone-200 p-4 md:grid-cols-[180px_1fr]">
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-stone-500">Filter</label>
                <Select value={status} onChange={(event) => updateParams({ status: event.target.value })}>
                  <option value="all">All</option>
                  <option value="completed">Completed</option>
                  <option value="skipped">Skipped</option>
                  <option value="remaining">Remaining</option>
                </Select>
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-stone-500">Search record</label>
                <TextInput
                  value={q}
                  placeholder="Record name"
                  onChange={(event) => updateParams({ q: event.target.value })}
                />
              </div>
            </div>
            {data.activity.entries.length === 0 ? (
              <div className="p-6 text-sm text-stone-600">No cleanup activity has been recorded for this user.</div>
            ) : (
              Object.entries(groupedEntries).map(([recordType, entries]) => (
                <section key={recordType} className="border-b border-stone-300 last:border-0">
                  <div className="bg-stone-100 px-4 py-2 text-xs font-black uppercase tracking-wide text-stone-600">{recordType}s</div>
                  {entries.map((entry) => {
                    const skip = skipDetails(entry.metadata);
                    return (
                      <div key={`${entry.timestamp}-${entry.recordId}-${entry.action}`} className="border-t border-stone-200 px-4 py-4 first:border-t-0">
                        <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
                          <div>
                            <p className="font-bold text-stone-950">{entry.recordName}</p>
                            <p className="text-sm text-stone-600">{actionLabel(entry.action, entry.metadata)} · {entry.source}</p>
                          </div>
                          <p className="text-sm text-stone-600">{formatDate(entry.timestamp)}</p>
                        </div>
                        {skip ? (
                          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                            <p className="font-bold">Skip reason: {skip.reason}</p>
                            {skip.notes ? <p className="mt-1">{skip.notes}</p> : null}
                          </div>
                        ) : null}
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
                    );
                  })}
                </section>
              ))
            )}
          </Panel>

          <div className="mt-4 flex items-center justify-between">
            <Button variant="secondary" disabled={page === 1} onClick={() => {
              const next = new URLSearchParams(params);
              next.set("page", String(Math.max(1, page - 1)));
              setParams(next);
            }}>Previous</Button>
            <span className="text-sm text-stone-600">Page {page}</span>
            <Button variant="secondary" disabled={data.activity.entries.length < data.activity.pageSize} onClick={() => {
              const next = new URLSearchParams(params);
              next.set("page", String(page + 1));
              setParams(next);
            }}>Next</Button>
          </div>
        </>
      ) : null}
    </main>
  );
}
