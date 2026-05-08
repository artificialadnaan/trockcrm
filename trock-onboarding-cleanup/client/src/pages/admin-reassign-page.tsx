import { Loader2, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { Button, FieldLabel, Panel, Select, TextInput } from "../components/ui";
import { useMe, useReassignmentMutations, useReassignmentRecords, useReassignmentUsers } from "../hooks/use-cleanup";
import type { RecordTypeSingular, ReassignmentRecord } from "../types/cleanup";

const recordTypes = ["all", "deal", "lead", "contact", "company"] as const;

function canUseAdminTools(role?: string) {
  return role === "admin" || role === "director";
}

function formatAmount(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(numeric);
}

export function AdminReassignPage() {
  const { data: user, isLoading: userLoading } = useMe();
  const adminEnabled = canUseAdminTools(user?.role);
  const [type, setType] = useState<(typeof recordTypes)[number]>("all");
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState("unassigned");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Record<string, ReassignmentRecord>>({});
  const [targetUserId, setTargetUserId] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const users = useReassignmentUsers(adminEnabled);
  const records = useReassignmentRecords({ type, q, owner, page }, adminEnabled);
  const mutations = useReassignmentMutations();
  const selectedRecords = useMemo(() => Object.values(selected), [selected]);
  const singleBulkType = selectedRecords.length > 0 ? selectedRecords[0].type : null;
  const mixedTypes = selectedRecords.some((record) => record.type !== singleBulkType);

  if (userLoading) {
    return (
      <main className="grid min-h-[80vh] place-items-center">
        <Loader2 className="h-7 w-7 animate-spin text-red-700" />
      </main>
    );
  }
  if (!adminEnabled) return <Navigate to="/cleanup" replace />;

  const clearSelection = () => setSelected({});
  const runSingle = (record: ReassignmentRecord) => {
    if (!targetUserId) {
      setMessage({ tone: "error", text: "Choose a target user before reassigning." });
      return;
    }
    mutations.single.mutate(
      { type: record.type, id: record.id, newAssignedToUserId: targetUserId },
      {
        onSuccess: () => {
          setMessage({ tone: "success", text: `Reassigned ${record.name}.` });
          clearSelection();
        },
        onError: (error) => setMessage({ tone: "error", text: error instanceof Error ? error.message : "Reassignment failed." }),
      },
    );
  };
  const runBulk = () => {
    if (!targetUserId) {
      setMessage({ tone: "error", text: "Choose a target user before reassigning." });
      return;
    }
    if (!singleBulkType || mixedTypes) {
      setMessage({ tone: "error", text: "Bulk reassignment requires selected records to be the same type." });
      return;
    }
    mutations.bulk.mutate(
      { type: singleBulkType, recordIds: selectedRecords.map((record) => record.id), newAssignedToUserId: targetUserId },
      {
        onSuccess: () => {
          setMessage({ tone: "success", text: `Reassigned ${selectedRecords.length} ${singleBulkType} records.` });
          clearSelection();
        },
        onError: (error) => setMessage({ tone: "error", text: error instanceof Error ? error.message : "Bulk reassignment failed." }),
      },
    );
  };

  return (
    <main className="mx-auto max-w-7xl px-4 pb-28 pt-6 sm:px-6 lg:pb-8 lg:pt-8">
      <div className="border-b border-stone-300 pb-5">
        <p className="text-sm font-bold uppercase tracking-wide text-red-800">Admin</p>
        <h1 className="mt-2 text-3xl font-black text-stone-950">Reassign cleanup records</h1>
      </div>

      <Panel className="mt-5 p-4">
        <div className="grid gap-4 md:grid-cols-[160px_1fr_260px]">
          <div className="space-y-2">
            <FieldLabel>Type</FieldLabel>
            <Select value={type} onChange={(event) => { setType(event.target.value as typeof type); setPage(1); clearSelection(); }}>
              {recordTypes.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <FieldLabel>Search</FieldLabel>
            <TextInput value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} placeholder="Record name or contact email" />
          </div>
          <div className="space-y-2">
            <FieldLabel>Owner</FieldLabel>
            <Select value={owner} onChange={(event) => { setOwner(event.target.value); setPage(1); clearSelection(); }}>
              <option value="all">all</option>
              <option value="unassigned">unassigned</option>
              {users.data?.map((item) => (
                <option key={item.id} value={item.id}>{item.email}</option>
              ))}
            </Select>
          </div>
        </div>
      </Panel>

      {message ? (
        <div className={`mt-4 rounded-md border p-3 text-sm ${message.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>
          {message.text}
        </div>
      ) : null}

      <Panel className="mt-5 overflow-hidden">
        <div className="hidden grid-cols-[48px_1fr_110px_160px_220px_150px] gap-3 border-b border-stone-300 bg-stone-200 px-4 py-3 text-xs font-bold uppercase tracking-wide text-stone-600 lg:grid">
          <span />
          <span>Record</span>
          <span>Type</span>
          <span>Stage</span>
          <span>Current owner</span>
          <span>Action</span>
        </div>
        {records.isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-stone-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading records
          </div>
        ) : records.data?.records.length === 0 ? (
          <div className="p-6 text-sm text-stone-600">No records match this view.</div>
        ) : (
          records.data?.records.map((record) => {
            const checked = Boolean(selected[record.id]);
            return (
              <div key={`${record.type}-${record.id}`} className="grid gap-3 border-b border-stone-200 px-4 py-4 last:border-0 lg:grid-cols-[48px_1fr_110px_160px_220px_150px] lg:items-center">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={checked}
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = { ...current };
                      if (event.target.checked) next[record.id] = record;
                      else delete next[record.id];
                      return next;
                    })
                  }
                />
                <div>
                  <p className="font-bold text-stone-950">{record.name}</p>
                  <p className="mt-1 text-sm text-stone-600">{formatAmount(record.amount) || record.cleanupAssignee?.email || "No amount"}</p>
                </div>
                <span className="text-sm text-stone-700">{record.type}</span>
                <span className="text-sm text-stone-700">{record.stage?.label ?? record.stage?.slug ?? ""}</span>
                <span className="text-sm text-stone-700">{record.owner?.email ?? "Unassigned"}</span>
                <Button variant="secondary" disabled={mutations.single.isPending} onClick={() => runSingle(record)}>
                  Reassign
                </Button>
              </div>
            );
          })
        )}
      </Panel>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-stone-600">
          Page {records.data?.page ?? page}; showing {records.data?.records.length ?? 0} of {records.data?.total ?? 0}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button>
          <Button variant="secondary" disabled={(records.data?.records.length ?? 0) < 50} onClick={() => setPage((value) => value + 1)}>Next</Button>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-300 bg-stone-100/95 p-3 backdrop-blur">
        <div className="mx-auto grid max-w-7xl gap-3 md:grid-cols-[1fr_320px_auto_auto] md:items-center">
          <p className="text-sm text-stone-700">{selectedRecords.length} selected {mixedTypes ? "(mixed types cannot bulk reassign)" : ""}</p>
          <Select value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)}>
            <option value="">Reassign selected to...</option>
            {users.data?.map((item) => (
              <option key={item.id} value={item.id}>{item.email}</option>
            ))}
          </Select>
          <Button variant="secondary" onClick={() => records.refetch()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button disabled={selectedRecords.length === 0 || mixedTypes || mutations.bulk.isPending} onClick={runBulk}>Apply</Button>
        </div>
      </div>
    </main>
  );
}
