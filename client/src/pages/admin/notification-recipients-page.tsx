import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAdminUsers } from "@/hooks/use-admin-users";
import {
  getNotificationRecipientGroup,
  updateNotificationRecipientGroup,
  type NotificationRecipient,
} from "@/hooks/use-lead-due-diligence";

const GROUP_KEY = "lead_due_diligence";

export function NotificationRecipientsPage() {
  const { users, loading: usersLoading } = useAdminUsers();
  const [recipients, setRecipients] = useState<NotificationRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());

  const loadRecipients = () => {
    let cancelled = false;
    setLoading(true);
    getNotificationRecipientGroup(GROUP_KEY)
      .then((result) => {
        if (cancelled) return;
        setRecipients(result.recipients);
        setSelectedUserIds(new Set(result.recipients.map((recipient) => recipient.userId)));
        setFetchError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? `Failed to load recipients: ${err.message}` : "Failed to load recipients.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  };

  useEffect(() => {
    return loadRecipients();
  }, []);

  const activeUsers = useMemo(
    () => users.filter((user) => user.isActive && (user.role === "admin" || user.role === "director")),
    [users]
  );

  const save = async () => {
    if (saving) return;
    if (selectedUserIds.size === 0) {
      const confirmed = window.confirm(
        "Save with no recipients? Due Diligence approval emails will not be sent until recipients are added back."
      );
      if (!confirmed) return;
    }

    setSaving(true);
    try {
      const result = await updateNotificationRecipientGroup(GROUP_KEY, [...selectedUserIds]);
      setRecipients(result.recipients);
      toast.success("Notification recipients updated");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Failed to update recipients: ${err.message}`
          : "Failed to update recipients. Please try again."
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading || usersLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading notification recipients
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Notification Recipients</h1>
        <p className="text-sm text-muted-foreground">Manage Due Diligence approval email recipients.</p>
      </div>

      {fetchError ? (
        <div className="space-y-3 border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>{fetchError}</p>
          <Button variant="outline" onClick={() => { loadRecipients(); }}>
            Retry
          </Button>
        </div>
      ) : (
        <section className="border bg-background p-4">
          <h2 className="font-semibold">Lead Due Diligence</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Current recipients: {recipients.length ? recipients.map((recipient) => recipient.email).join(", ") : "none"}
          </p>
          <div className="mt-4 grid gap-2">
            {/* TODO: Replace checkbox list with autocomplete picker when user count
                exceeds ~50. Current pattern is fine for the existing T Rock team size. */}
            {activeUsers.map((user) => (
              <label key={user.id} className="flex items-center gap-3 border p-3 text-sm">
                <input
                  type="checkbox"
                  checked={selectedUserIds.has(user.id)}
                  onChange={(event) => {
                    setSelectedUserIds((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(user.id);
                      else next.delete(user.id);
                      return next;
                    });
                  }}
                />
                <span className="font-medium">{user.displayName}</span>
                <span className="text-muted-foreground">{user.email}</span>
                <span className="ml-auto text-xs uppercase text-muted-foreground">{user.role}</span>
              </label>
            ))}
          </div>
          <Button className="mt-4" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving..." : "Save recipients"}
          </Button>
        </section>
      )}
    </div>
  );
}
