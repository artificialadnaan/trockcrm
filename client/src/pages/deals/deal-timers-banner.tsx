import { useState, useEffect, useCallback } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type TimerType =
  | "proposal_response"
  | "estimate_review"
  | "companycam_service"
  | "final_billing"
  | "custom";

type TimerStatus = "active" | "completed" | "expired";

interface DealTimer {
  id: string;
  dealId: string;
  timerType: TimerType;
  label: string | null;
  status: TimerStatus;
  startedAt: string;
  deadlineAt: string;
  completedAt: string | null;
}

const TIMER_LABELS: Record<TimerType, string> = {
  proposal_response: "Proposal Response",
  estimate_review: "Estimate Review",
  companycam_service: "CompanyCam",
  final_billing: "Final Billing",
  custom: "Timer",
};

function getTimerColor(timer: DealTimer): string {
  const now = Date.now();
  const due = new Date(timer.deadlineAt).getTime();
  const start = new Date(timer.startedAt).getTime();
  const total = due - start;
  const remaining = due - now;

  if (remaining <= 0) return "bg-red-50 border-red-200 text-red-700";
  const pct = remaining / total;
  if (pct > 0.5) return "bg-green-50 border-green-200 text-green-700";
  if (pct > 0.25) return "bg-amber-50 border-amber-200 text-amber-700";
  return "bg-red-50 border-red-200 text-red-700";
}

function formatCountdown(dueAt: string): string {
  const now = Date.now();
  const due = new Date(dueAt).getTime();
  const diffMs = due - now;

  if (diffMs <= 0) {
    const overdueMs = Math.abs(diffMs);
    const overdueDays = Math.floor(overdueMs / (1000 * 60 * 60 * 24));
    if (overdueDays > 0) return `${overdueDays} day${overdueDays !== 1 ? "s" : ""} overdue`;
    const overdueHours = Math.floor(overdueMs / (1000 * 60 * 60));
    return `${overdueHours}h overdue`;
  }

  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) return `${days}d ${hours}h remaining`;
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m remaining`;
}

interface DealTimersBannerProps {
  dealId: string;
}

export function DealTimersBanner({ dealId }: DealTimersBannerProps) {
  const [timers, setTimers] = useState<DealTimer[]>([]);
  const [, setTick] = useState(0);

  const fetchTimers = useCallback(async () => {
    try {
      const data = await api<{ active: DealTimer[]; recent: DealTimer[]; all: DealTimer[] }>(`/deals/${dealId}/timers`);
      setTimers(data.active);
    } catch {
      // Silently fail — timers are supplemental UI
    }
  }, [dealId]);

  useEffect(() => {
    fetchTimers();
  }, [fetchTimers]);

  // Tick every minute to update countdown display
  useEffect(() => {
    const interval = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  const handleComplete = async (timerId: string) => {
    try {
      await api(`/deals/${dealId}/timers/${timerId}`, {
        method: "PATCH",
        json: { action: "complete" },
      });
      toast.success("Timer marked complete");
      fetchTimers();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update timer");
    }
  };

  if (timers.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 pb-3 border-b">
      {timers.map((timer) => {
        const label =
          timer.timerType === "custom" && timer.label ? timer.label : TIMER_LABELS[timer.timerType];
        const colorClass = getTimerColor(timer);
        const countdown = formatCountdown(timer.deadlineAt);

        return (
          <div
            key={timer.id}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${colorClass}`}
          >
            <Clock className="h-3 w-3 flex-shrink-0" />
            <span>{label}</span>
            <span className="opacity-75">·</span>
            <span>{countdown}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2.5 text-xs ml-1 hover:bg-white/50"
              aria-label={`Complete ${label} timer`}
              onClick={() => handleComplete(timer.id)}
            >
              Complete
            </Button>
          </div>
        );
      })}
    </div>
  );
}
