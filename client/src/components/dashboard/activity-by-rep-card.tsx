import { ChevronRight, Mail, MessageSquareText, Phone, Users, Video } from "lucide-react";

type ActivityRow = {
  repId: string;
  repName: string;
  calls: number;
  emails: number;
  meetings: number;
  notes: number;
  total: number;
};

type RepCardRow = {
  repId: string;
  repName: string;
  activeDeals: number;
  pipelineValue: number;
  staleDeals: number;
  staleLeads: number;
};

interface ActivityByRepCardProps {
  activityByRep: ActivityRow[];
  repCards: RepCardRow[];
  onSelectRep: (repId: string) => void;
  formatCurrency: (value: number) => string;
}

function getActivityTone(total: number) {
  if (total >= 20) {
    return {
      label: "High output",
      badgeClass: "bg-emerald-100 text-emerald-700",
      borderClass: "border-emerald-200",
    };
  }

  if (total >= 8) {
    return {
      label: "Steady",
      badgeClass: "bg-amber-100 text-amber-700",
      borderClass: "border-amber-200",
    };
  }

  return {
    label: "Needs review",
    badgeClass: "bg-rose-100 text-rose-700",
    borderClass: "border-rose-200",
  };
}

function getInitials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function ActivityByRepCard({
  activityByRep,
  repCards,
  onSelectRep,
  formatCurrency,
}: ActivityByRepCardProps) {
  const rows = repCards
    .map((rep) => {
      const activity = activityByRep.find((row) => row.repId === rep.repId) ?? {
        repId: rep.repId,
        repName: rep.repName,
        calls: 0,
        emails: 0,
        meetings: 0,
        notes: 0,
        total: 0,
      };

      return {
        ...rep,
        ...activity,
      };
    })
    .sort((left, right) => {
      if (right.total !== left.total) return right.total - left.total;
      if (right.activeDeals !== left.activeDeals) return right.activeDeals - left.activeDeals;
      return right.pipelineValue - left.pipelineValue;
    });

  const teamTotals = rows.reduce(
    (acc, row) => ({
      total: acc.total + row.total,
      calls: acc.calls + row.calls,
      emails: acc.emails + row.emails,
      meetings: acc.meetings + row.meetings,
      notes: acc.notes + row.notes,
    }),
    { total: 0, calls: 0, emails: 0, meetings: 0, notes: 0 }
  );

  const topRep = rows[0] ?? null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-gray-100">
        <div>
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
            Activity by Rep
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Click a rep to open their detailed activity summary and drill into pipeline, follow-up, and stale work.
          </p>
        </div>
        <div className="hidden lg:flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1.5 text-[11px] font-semibold text-gray-600">
          <Users className="h-3.5 w-3.5" />
          {rows.length} rep{rows.length === 1 ? "" : "s"} tracked
        </div>
      </div>

      <div className="grid gap-3 px-5 py-4 md:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Team activity</p>
          <p className="mt-2 text-3xl font-black text-gray-900">{teamTotals.total}</p>
          <p className="mt-1 text-xs text-gray-500">Calls, emails, meetings, and notes in the selected period</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Most active rep</p>
          <p className="mt-2 text-lg font-bold text-gray-900">{topRep?.repName ?? "No rep activity"}</p>
          <p className="mt-1 text-xs text-gray-500">
            {topRep ? `${topRep.total} logged activities across ${topRep.activeDeals} active deals` : "No logged activity yet"}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Mix</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-1 font-semibold text-rose-700">
              <Phone className="h-3 w-3" />
              {teamTotals.calls} calls
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-1 font-semibold text-sky-700">
              <Mail className="h-3 w-3" />
              {teamTotals.emails} emails
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 font-semibold text-indigo-700">
              <Video className="h-3 w-3" />
              {teamTotals.meetings} meetings
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 font-semibold text-emerald-700">
              <MessageSquareText className="h-3 w-3" />
              {teamTotals.notes} notes
            </span>
          </div>
        </div>
      </div>

      <div className="px-5 pb-5">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">No activity data.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => {
              const tone = getActivityTone(row.total);
              return (
                <button
                  key={row.repId}
                  type="button"
                  onClick={() => onSelectRep(row.repId)}
                  className={`w-full rounded-2xl border bg-white px-4 py-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md ${tone.borderClass}`}
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#CC0000] text-sm font-bold text-white">
                        {getInitials(row.repName)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-base font-bold text-gray-900">{row.repName}</p>
                          <span className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] font-semibold ${tone.badgeClass}`}>
                            {tone.label}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-gray-500">
                          {row.activeDeals} active deals • {formatCurrency(row.pipelineValue)} pipeline • {row.staleDeals} stale deals • {row.staleLeads} stale leads
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3 lg:min-w-[420px]">
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        <div className="rounded-xl bg-gray-50 px-3 py-2">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Total</p>
                          <p className="mt-1 text-lg font-black text-gray-900">{row.total}</p>
                        </div>
                        <div className="rounded-xl bg-rose-50 px-3 py-2">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-rose-400">Calls</p>
                          <p className="mt-1 text-lg font-black text-rose-700">{row.calls}</p>
                        </div>
                        <div className="rounded-xl bg-sky-50 px-3 py-2">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-sky-400">Emails</p>
                          <p className="mt-1 text-lg font-black text-sky-700">{row.emails}</p>
                        </div>
                        <div className="rounded-xl bg-indigo-50 px-3 py-2">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-400">Meetings</p>
                          <p className="mt-1 text-lg font-black text-indigo-700">{row.meetings}</p>
                        </div>
                        <div className="rounded-xl bg-emerald-50 px-3 py-2">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">Notes</p>
                          <p className="mt-1 text-lg font-black text-emerald-700">{row.notes}</p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-xs font-semibold text-gray-500">
                        <span>Open detailed activity report</span>
                        <span className="inline-flex items-center gap-1 text-[#CC0000]">
                          Review rep summary
                          <ChevronRight className="h-3.5 w-3.5" />
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
