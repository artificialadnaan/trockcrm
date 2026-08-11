import { CalendarDays } from "lucide-react";
import { Link } from "react-router-dom";
import { useOfficeScopedHref } from "@/hooks/use-office-scope";

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
 * The same instant as a `<input type="date">` value ("YYYY-MM-DD").
 *
 * Sliced in UTC for the reason formatBidDueDate formats in UTC: the column is a timestamptz pinned to UTC
 * midnight carrying a date-only business value, so reading it locally lands on the PREVIOUS day anywhere
 * west of UTC. A date input populated that way silently shifts the deadline a day earlier every time
 * someone opens the form and saves it — the kind of drift nobody attributes to the form.
 */
export function toBidDueDateInputValue(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * Informational banner that surfaces a deal's bid due date at the top of the deal body. Renders
 * nothing when the date is absent/invalid.
 */
export function BidDueDateBanner({
  bidDueDate,
  dealId,
}: {
  bidDueDate?: string | null;
  /** When given, the banner offers the way to change the date. Omitted on surfaces with no edit route. */
  dealId?: string | null;
}) {
  const scopedHref = useOfficeScopedHref();
  const formatted = formatBidDueDate(bidDueDate);
  if (!formatted) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
      <CalendarDays className="h-4 w-4 flex-shrink-0 text-red-500" />
      <span>Bid due date: {formatted}</span>
      {/* The point of the banner is that this date matters, so the place it is shown is the place people
          go to correct it. Until now it could only be changed from the Scoping tab's Project Overview
          section, which nobody finds by looking for a bid due date. Office scope is carried, because a
          bare /deals/:id/edit resolves in the viewer's default tenant. */}
      {dealId ? (
        <Link
          to={scopedHref(`/deals/${dealId}/edit`)}
          className="ml-auto shrink-0 font-semibold underline decoration-dotted underline-offset-4 hover:text-red-900"
        >
          Change
        </Link>
      ) : null}
    </div>
  );
}
