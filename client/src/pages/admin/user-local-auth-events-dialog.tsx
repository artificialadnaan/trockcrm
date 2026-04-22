import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LocalAuthEvent } from "@/hooks/use-admin-users";

type UserLocalAuthEventsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: LocalAuthEvent[];
  userEmail: string | null;
  loading?: boolean;
};

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function UserLocalAuthEventsDialog(props: UserLocalAuthEventsDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Local Auth History</DialogTitle>
          <DialogDescription>
            Recent invite and login events for {props.userEmail ?? "this user"}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {props.loading ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-slate-500">
              Loading local-auth history...
            </div>
          ) : props.events.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-slate-500">
              No local-auth events recorded yet.
            </div>
          ) : props.events.map((event) => (
            <div key={event.id} className="rounded-lg border bg-white p-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-900">{event.eventType.replace(/_/g, " ")}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {event.actorDisplayName ? `Actor: ${event.actorDisplayName}` : "Actor: system"}
                  </div>
                </div>
                <div className="text-xs text-slate-500">{formatTimestamp(event.createdAt)}</div>
              </div>
              {event.metadata ? (
                <pre className="mt-3 whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs text-slate-600">
                  {JSON.stringify(event.metadata, null, 2)}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
