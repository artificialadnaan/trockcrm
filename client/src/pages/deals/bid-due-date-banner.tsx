import { CalendarDays } from "lucide-react";

/**
 * Format a deal's bid due date for display. `deals.bid_due_date` is a timestamptz persisted at UTC
 * midnight (the business value is date-only — see service.ts createDeal), so it arrives on the wire
 * as e.g. "2026-07-03T00:00:00.000Z". Formatting it in LOCAL time would render the PREVIOUS calendar
 * day west of UTC (Jul 2 in America/Chicago), so we format the instant in UTC to surface the intended
 * day in every timezone. Returns null for missing/invalid values so the caller renders nothing.
 */
export function formatBidDueDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Informational banner that surfaces a deal's bid due date at the top of the deal body. Renders
 * nothing when the date is absent/invalid.
 */
export function BidDueDateBanner({ bidDueDate }: { bidDueDate?: string | null }) {
  const formatted = formatBidDueDate(bidDueDate);
  if (!formatted) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
      <CalendarDays className="h-4 w-4 flex-shrink-0 text-red-500" />
      <span>Bid due date: {formatted}</span>
    </div>
  );
}
