import { Paperclip, Play, Headphones, ArrowDownToLine, ChevronRight } from "lucide-react";

export type EmailRow = {
  id: string;
  fromName: string;
  fromEmail: string;
  fromInitials: string;
  fromMe: boolean;
  subject: string;
  preview: string;
  date: string;
  unread?: boolean;
  hasAttachment?: boolean;
  attachmentCount?: number;
};

export type RecordingRow = {
  id: string;
  contactName: string;
  contactInitials: string;
  direction: "inbound" | "outbound";
  durationSeconds: number;
  date: string;
  transcript: string;
  hasTranscript: boolean;
  topics?: string[];
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function EmailList({ emails }: { emails: EmailRow[] }) {
  return (
    <div className="divide-y divide-slate-100">
      {emails.length === 0 ? (
        <p className="px-6 py-12 text-center text-sm text-slate-500">No emails yet.</p>
      ) : (
        emails.map((e) => (
          <button
            key={e.id}
            type="button"
            className="flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-slate-50"
          >
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[10px] font-black uppercase text-white ${
                e.fromMe ? "bg-slate-900" : "bg-brand-red"
              }`}
            >
              {e.fromInitials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className={`truncate text-sm ${e.unread ? "font-black text-slate-950" : "font-semibold text-slate-700"}`}>
                  {e.fromMe ? "You" : e.fromName}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {e.fromMe ? "→" : "from"} {e.fromEmail}
                </p>
                {e.unread ? (
                  <span className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-red" aria-label="Unread" />
                ) : null}
              </div>
              <p className={`mt-0.5 truncate text-sm ${e.unread ? "font-black text-slate-950" : "font-bold text-slate-900"}`}>
                {e.subject}
              </p>
              <p className="mt-0.5 truncate text-xs text-slate-500">{e.preview}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
              {e.hasAttachment ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
                  <Paperclip className="h-3 w-3" />
                  {e.attachmentCount ?? 1}
                </span>
              ) : null}
              <span className="font-semibold tabular-nums">{e.date}</span>
              <ChevronRight className="h-4 w-4 text-slate-400" />
            </div>
          </button>
        ))
      )}
    </div>
  );
}

function FauxWaveform({ seed }: { seed: number }) {
  const bars = Array.from({ length: 40 }, (_, i) => {
    const noise = Math.sin(i * 1.8 + seed) * 0.4 + Math.cos(i * 0.7 + seed * 2) * 0.3;
    const h = 30 + Math.abs(noise) * 70;
    return h;
  });
  return (
    <div className="flex h-7 items-end gap-[2px]">
      {bars.map((h, i) => (
        <span
          key={i}
          className="w-1 rounded-sm bg-slate-300 transition-colors group-hover:bg-brand-red/60"
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}

export function RecordingsList({ recordings }: { recordings: RecordingRow[] }) {
  return (
    <div className="divide-y divide-slate-100">
      {recordings.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <Headphones className="mx-auto h-6 w-6 text-slate-400" />
          <p className="mt-2 text-sm text-slate-500">No call recordings yet.</p>
        </div>
      ) : (
        recordings.map((r) => (
          <div key={r.id} className="group px-5 py-4 transition-colors hover:bg-slate-50">
            <div className="flex items-start gap-4">
              <button
                type="button"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-red text-white shadow-sm hover:bg-brand-red/90"
                aria-label="Play recording"
              >
                <Play className="h-4 w-4 fill-current" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-[9px] font-black uppercase text-slate-700">
                    {r.contactInitials}
                  </span>
                  <p className="text-sm font-bold text-slate-950">{r.contactName}</p>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${
                      r.direction === "inbound"
                        ? "bg-blue-50 text-blue-700 ring-blue-200"
                        : "bg-emerald-50 text-emerald-700 ring-emerald-200"
                    }`}
                  >
                    {r.direction}
                  </span>
                  {r.hasTranscript ? (
                    <span className="inline-flex items-center rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 ring-1 ring-violet-200">
                      Transcribed
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <FauxWaveform seed={parseInt(r.id.replace(/\D/g, ""), 10) || 1} />
                  <p className="shrink-0 text-xs font-semibold tabular-nums text-slate-700">
                    {formatDuration(r.durationSeconds)}
                  </p>
                </div>
                {r.transcript ? (
                  <p className="mt-2 line-clamp-2 text-xs italic text-slate-600">&ldquo;{r.transcript}&rdquo;</p>
                ) : null}
                {r.topics && r.topics.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.topics.map((topic) => (
                      <span
                        key={topic}
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-700"
                      >
                        {topic}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2 text-xs text-slate-500">
                <span className="font-semibold tabular-nums">{r.date}</span>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Download"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
