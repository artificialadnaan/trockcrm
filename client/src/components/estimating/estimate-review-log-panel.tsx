function formatEventType(value: string | null | undefined) {
  if (!value) return "Activity";
  return value.replace(/_/g, " ");
}

function formatSubjectType(value: string | null | undefined) {
  if (!value) return "estimating item";
  return value.replace(/_/g, " ");
}

function formatTimestamp(value: string | Date | null | undefined) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No timestamp" : date.toLocaleString();
}

export function EstimateReviewLogPanel({ events }: { events: any[] }) {
  return (
    <section className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Review Log</h3>
        <p className="text-xs text-muted-foreground">
          Most recent estimator decisions and system review activity.
        </p>
      </div>

      {events.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No estimator review events recorded yet.
        </div>
      ) : (
        <div className="divide-y">
          {events.map((event) => (
            <div key={event.id} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_220px] md:gap-4">
              <div>
                <div className="font-medium capitalize">
                  {formatEventType(event.eventType)}
                </div>
                <div className="text-xs text-muted-foreground capitalize">
                  {formatSubjectType(event.subjectType)}
                </div>
                {event.reason ? (
                  <div className="mt-1 text-xs text-muted-foreground">{event.reason}</div>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground md:text-right">
                {formatTimestamp(event.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
