import { ChevronRight, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EmailRow, LinkedRecordType } from "./types";

const statusStyles = {
  linked: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  unassigned: "bg-amber-50 text-amber-700 ring-amber-200",
  sent: "bg-slate-100 text-slate-700 ring-slate-200",
  low_confidence: "bg-brand-red/10 text-brand-red ring-brand-red/20",
} satisfies Record<EmailRow["status"], string>;

const linkedRecordStyles = {
  deal: "bg-brand-red/10 text-brand-red ring-brand-red/20",
  lead: "bg-blue-50 text-blue-700 ring-blue-200",
  contact: "bg-violet-50 text-violet-700 ring-violet-200",
  company: "bg-amber-50 text-amber-700 ring-amber-200",
  property: "bg-emerald-50 text-emerald-700 ring-emerald-200",
} satisfies Record<LinkedRecordType, string>;

const statusLabel = {
  linked: "Linked",
  unassigned: "Unassigned",
  sent: "Sent",
  low_confidence: "Low confidence",
} satisfies Record<EmailRow["status"], string>;

export function EmailList({ emails, className }: { emails: EmailRow[]; className?: string }) {
  return (
    <div className={cn("divide-y divide-slate-100", className)}>
      {emails.length === 0 ? (
        <p className="px-6 py-12 text-center text-sm text-slate-500">No emails yet.</p>
      ) : (
        emails.map((email) => (
          <button
            key={email.id}
            type="button"
            className="flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-slate-50"
          >
            <span
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[10px] font-black uppercase text-white",
                email.fromMe ? "bg-slate-900" : "bg-brand-red",
              )}
            >
              {email.fromInitials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className={cn("truncate text-sm", email.unread ? "font-black text-slate-950" : "font-semibold text-slate-700")}>
                  {email.fromMe ? "You" : email.fromName}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {email.fromMe ? "to" : "from"} {email.fromEmail}
                </p>
                {email.unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-red" aria-label="Unread" /> : null}
                <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1", statusStyles[email.status])}>
                  {statusLabel[email.status]}
                </span>
              </div>
              <p className={cn("mt-0.5 truncate text-sm", email.unread ? "font-black text-slate-950" : "font-bold text-slate-900")}>
                {email.subject}
              </p>
              <p className="mt-0.5 truncate text-xs text-slate-500">{email.preview}</p>
              {email.linkedRecords && email.linkedRecords.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {email.linkedRecords.map((record) => (
                    <span
                      key={`${record.type}-${record.id}`}
                      className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1", linkedRecordStyles[record.type])}
                    >
                      {record.type}: {record.label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
              {email.hasAttachment ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
                  <Paperclip className="h-3 w-3" />
                  {email.attachmentCount ?? 1}
                </span>
              ) : null}
              <span className="font-semibold tabular-nums">{email.date}</span>
              <ChevronRight className="h-4 w-4 text-slate-400" />
            </div>
          </button>
        ))
      )}
    </div>
  );
}
