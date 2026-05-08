import { Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SkipModal } from "../components/skip-modal";
import { Badge, Button, Panel, TextInput } from "../components/ui";
import { useCleanupMutations, useQueue } from "../hooks/use-cleanup";
import type { CleanupStatus, QueueRecord, RecordType } from "../types/cleanup";
import { TYPE_TO_SINGULAR } from "../types/cleanup";

const labels: Record<RecordType, string> = {
  deals: "Deals",
  leads: "Leads",
  contacts: "Contacts",
  companies: "Companies",
};

const tabs = ["all", "pending", "completed", "skipped", "needs_review"] as const;

function validType(value: string | undefined): RecordType {
  if (value === "deals" || value === "leads" || value === "contacts" || value === "companies") return value;
  return "deals";
}

function formatDate(value?: string | null) {
  if (!value) return "No activity";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function statusOf(record: QueueRecord): CleanupStatus {
  return record.cleanupStatus ?? "pending";
}

export function RecordListPage() {
  const type = validType(useParams().type);
  const singular = TYPE_TO_SINGULAR[type];
  const { data: queue, isLoading } = useQueue();
  const navigate = useNavigate();
  const [tab, setTab] = useState<(typeof tabs)[number]>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [skipTarget, setSkipTarget] = useState<QueueRecord | null>(null);
  const { skip } = useCleanupMutations(skipTarget?.type, skipTarget?.id);

  const records = useMemo(() => {
    const base = queue?.[singular] ?? [];
    return base
      .filter((record) => {
        const status = statusOf(record);
        if (tab === "pending" && status !== "pending") return false;
        if (tab === "completed" && status !== "completed") return false;
        if (tab === "skipped" && status !== "skipped") return false;
        if (tab === "needs_review" && !record.missingFields.some((field) => field.severity === "review")) return false;
        if (query && !record.name.toLowerCase().includes(query.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        const pendingA = statusOf(a) === "pending" ? 0 : 1;
        const pendingB = statusOf(b) === "pending" ? 0 : 1;
        if (pendingA !== pendingB) return pendingA - pendingB;
        return b.missingFields.length - a.missingFields.length;
      });
  }, [query, queue, singular, tab]);

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const visible = records.slice((page - 1) * pageSize, page * pageSize);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-col gap-4 border-b border-stone-300 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <Link to="/cleanup" className="text-sm font-semibold text-red-800 hover:text-red-900">
            Back to dashboard
          </Link>
          <h1 className="mt-2 text-3xl font-black">{labels[type]}</h1>
          <p className="text-sm text-stone-600">{records.length} records in this view</p>
        </div>
        <div className="relative w-full md:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-stone-500" />
          <TextInput value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} className="pl-10" placeholder="Search by name" />
        </div>
      </div>

      <div className="mt-5 flex gap-2 overflow-x-auto pb-2">
        {tabs.map((item) => (
          <button
            key={item}
            onClick={() => {
              setTab(item);
              setPage(1);
            }}
            className={`min-h-11 whitespace-nowrap rounded-md border px-4 text-sm font-semibold ${
              tab === item ? "border-red-700 bg-red-700 text-stone-50" : "border-stone-300 bg-stone-50 text-stone-700"
            }`}
          >
            {item.replace("_", " ")}
          </button>
        ))}
      </div>

      <Panel className="mt-3 overflow-hidden">
        <div className="hidden grid-cols-[1fr_220px_160px_220px] gap-4 border-b border-stone-300 bg-stone-200 px-4 py-3 text-xs font-bold uppercase tracking-wide text-stone-600 md:grid">
          <span>Record</span>
          <span>Missing fields</span>
          <span>Status</span>
          <span>Actions</span>
        </div>
        {isLoading ? (
          <div className="p-6 text-sm text-stone-600">Loading records...</div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-sm text-stone-600">No records match this view.</div>
        ) : (
          visible.map((record) => (
            <div key={record.id} className="grid gap-3 border-b border-stone-200 px-4 py-4 last:border-0 md:grid-cols-[1fr_220px_160px_220px] md:items-center">
              <div>
                <p className="font-bold text-stone-950">{record.name}</p>
                <p className="mt-1 text-sm text-stone-600">
                  {record.stage?.label ?? statusOf(record)} · {formatDate(record.lastActivityDate)}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {record.missingFields.length === 0 ? (
                  <Badge tone="green">Ready</Badge>
                ) : (
                  record.missingFields.slice(0, 3).map((field) => (
                    <Badge key={field.field + field.label} tone={field.severity === "required" ? "red" : "amber"}>
                      {field.label}
                    </Badge>
                  ))
                )}
                {record.missingFields.length > 3 ? <Badge>+{record.missingFields.length - 3}</Badge> : null}
              </div>
              <div>
                <Badge tone={statusOf(record) === "pending" ? "neutral" : statusOf(record) === "completed" ? "green" : "amber"}>{statusOf(record)}</Badge>
              </div>
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => navigate(`/cleanup/${type}/${record.id}`)}>
                  Clean
                </Button>
                <Button variant="secondary" className="flex-1" onClick={() => setSkipTarget(record)}>
                  Skip
                </Button>
              </div>
            </div>
          ))
        )}
      </Panel>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-stone-600">
          Page {page} of {pageCount}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            Previous
          </Button>
          <Button variant="secondary" disabled={page === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>
            Next
          </Button>
        </div>
      </div>

      <SkipModal
        open={Boolean(skipTarget)}
        pending={skip.isPending}
        onClose={() => setSkipTarget(null)}
        onConfirm={(skip_reason, skip_notes) =>
          skip.mutate(
            { skip_reason, skip_notes },
            {
              onSuccess: () => setSkipTarget(null),
            },
          )
        }
      />
    </main>
  );
}
