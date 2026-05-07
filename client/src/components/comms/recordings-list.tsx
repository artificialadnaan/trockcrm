import { ArrowDownToLine, Headphones, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RecordingRow } from "./types";

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

function FauxWaveform({ seed }: { seed: number }) {
  const bars = Array.from({ length: 40 }, (_, index) => {
    const noise = Math.sin(index * 1.8 + seed) * 0.4 + Math.cos(index * 0.7 + seed * 2) * 0.3;
    return 30 + Math.abs(noise) * 70;
  });

  return (
    <div className="flex h-7 items-end gap-[2px]" aria-hidden>
      {bars.map((height, index) => (
        <span
          key={index}
          className="w-1 rounded-sm bg-slate-300 transition-colors group-hover:bg-brand-red/60"
          style={{ height: `${height}%` }}
        />
      ))}
    </div>
  );
}

export function RecordingsList({ recordings, className }: { recordings: RecordingRow[]; className?: string }) {
  return (
    <div className={cn("divide-y divide-slate-100", className)}>
      {recordings.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <Headphones className="mx-auto h-6 w-6 text-slate-400" />
          <p className="mt-2 text-sm text-slate-500">No call recordings yet.</p>
        </div>
      ) : (
        recordings.map((recording) => (
          <div key={recording.id} className="group px-5 py-4 transition-colors hover:bg-slate-50">
            <div className="flex items-start gap-4">
              <button
                type="button"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-red text-white shadow-sm hover:bg-brand-red/90"
                aria-label={`Play recording with ${recording.contactName}`}
              >
                <Play className="h-4 w-4 fill-current" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-[9px] font-black uppercase text-slate-700">
                    {recording.contactInitials}
                  </span>
                  <p className="text-sm font-bold text-slate-950">{recording.contactName}</p>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1",
                      recording.direction === "inbound"
                        ? "bg-blue-50 text-blue-700 ring-blue-200"
                        : "bg-emerald-50 text-emerald-700 ring-emerald-200",
                    )}
                  >
                    {recording.direction}
                  </span>
                  {recording.hasTranscript ? (
                    <span className="inline-flex items-center rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 ring-1 ring-violet-200">
                      Transcribed
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 ring-1 ring-slate-200">
                      No transcript
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <FauxWaveform seed={parseInt(recording.id.replace(/\D/g, ""), 10) || 1} />
                  <p className="shrink-0 text-xs font-semibold tabular-nums text-slate-700">
                    {formatDuration(recording.durationSeconds)}
                  </p>
                </div>
                {recording.transcript ? (
                  <p className="mt-2 line-clamp-2 text-xs italic text-slate-600">&quot;{recording.transcript}&quot;</p>
                ) : null}
                {recording.topics && recording.topics.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {recording.topics.map((topic) => (
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
                <span className="font-semibold tabular-nums">{recording.date}</span>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  aria-label={`Download recording with ${recording.contactName}`}
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
