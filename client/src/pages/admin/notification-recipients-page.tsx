import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  NOTIFICATION_RECIPIENT_GROUPS,
  type NotificationRecipientGroupDefinition,
} from "@trock-crm/shared/types";
import { Button } from "@/components/ui/button";
import { useAdminUsers } from "@/hooks/use-admin-users";
import {
  getNotificationRecipientGroup,
  updateNotificationRecipientGroup,
  type NotificationRecipient,
} from "@/hooks/use-lead-due-diligence";

/**
 * One page, one section per registered group, rather than a route per group.
 *
 * A `:key` route would need an index page to link to anyway — the sidebar entry and the document-title map
 * both key off this one static path — so it is strictly more surface for the same job. The sections carry
 * no per-group navigation state and there are three of them; they stack.
 *
 * Every ACTIVE user is assignable, not only admins and directors. The narrower filter came from the first
 * group being an approval queue, and it silently made the other groups unusable: the bid due date report
 * goes to an estimator, whose role is `rep`, and there was no way to tick that box.
 */

interface GroupState {
  recipients: NotificationRecipient[];
  selectedUserIds: Set<string>;
  error: string | null;
  loading: boolean;
  saving: boolean;
}

const INITIAL_GROUP_STATE: GroupState = {
  recipients: [],
  selectedUserIds: new Set(),
  error: null,
  loading: true,
  saving: false,
};

export function NotificationRecipientsPage() {
  const { users, loading: usersLoading } = useAdminUsers();
  const [groups, setGroups] = useState<Record<string, GroupState>>(() =>
    Object.fromEntries(NOTIFICATION_RECIPIENT_GROUPS.map((definition) => [definition.key, INITIAL_GROUP_STATE]))
  );
  const [initialLoading, setInitialLoading] = useState(true);
  const cancelled = useRef(false);

  const patchGroup = useCallback((key: string, patch: Partial<GroupState>) => {
    if (cancelled.current) return;
    setGroups((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }, []);

  const loadGroup = useCallback(
    async (key: string) => {
      patchGroup(key, { loading: true });
      try {
        const result = await getNotificationRecipientGroup(key);
        patchGroup(key, {
          recipients: result.recipients,
          selectedUserIds: new Set(result.recipients.map((recipient) => recipient.userId)),
          error: null,
          loading: false,
        });
      } catch (err) {
        // Per group, not per page: one key failing must not take the other groups' lists away with it.
        patchGroup(key, {
          error: err instanceof Error ? `Failed to load recipients: ${err.message}` : "Failed to load recipients.",
          loading: false,
        });
      }
    },
    [patchGroup]
  );

  useEffect(() => {
    cancelled.current = false;
    void Promise.all(NOTIFICATION_RECIPIENT_GROUPS.map((definition) => loadGroup(definition.key))).then(() => {
      // Only the FIRST pass blanks the page. A later Retry redraws its own section and leaves the rest.
      if (!cancelled.current) setInitialLoading(false);
    });
    return () => {
      cancelled.current = true;
    };
  }, [loadGroup]);

  const activeUsers = useMemo(() => users.filter((user) => user.isActive), [users]);

  const save = async (definition: NotificationRecipientGroupDefinition) => {
    const state = groups[definition.key];
    if (state.saving) return;
    if (state.selectedUserIds.size === 0) {
      const confirmed = window.confirm(`Save with no recipients? ${definition.emptyWarning}`);
      if (!confirmed) return;
    }

    patchGroup(definition.key, { saving: true });
    try {
      const result = await updateNotificationRecipientGroup(definition.key, [...state.selectedUserIds]);
      patchGroup(definition.key, { recipients: result.recipients, saving: false });
      toast.success("Notification recipients updated");
    } catch (err) {
      patchGroup(definition.key, { saving: false });
      toast.error(
        err instanceof Error
          ? `Failed to update recipients: ${err.message}`
          : "Failed to update recipients. Please try again."
      );
    }
  };

  if (initialLoading || usersLoading) {
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
        <p className="text-sm text-muted-foreground">Manage who receives each system notification.</p>
      </div>

      {NOTIFICATION_RECIPIENT_GROUPS.map((definition) => {
        const state = groups[definition.key];
        return (
          <section key={definition.key} data-group-key={definition.key} className="border bg-background p-4">
            <h2 className="font-semibold">{definition.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{definition.description}</p>

            {state.error ? (
              <div className="mt-4 space-y-3 border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <p>{state.error}</p>
                <Button variant="outline" disabled={state.loading} onClick={() => { void loadGroup(definition.key); }}>
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <p className="mt-1 text-sm text-muted-foreground">
                  Current recipients:{" "}
                  {state.recipients.length ? state.recipients.map((recipient) => recipient.email).join(", ") : "none"}
                </p>
                <div className="mt-4 grid gap-2">
                  {/* TODO: Replace checkbox list with autocomplete picker when user count
                      exceeds ~50. Current pattern is fine for the existing T Rock team size. */}
                  {activeUsers.map((user) => (
                    <label key={user.id} className="flex items-center gap-3 border p-3 text-sm">
                      <input
                        type="checkbox"
                        checked={state.selectedUserIds.has(user.id)}
                        onChange={(event) => {
                          const next = new Set(state.selectedUserIds);
                          if (event.target.checked) next.add(user.id);
                          else next.delete(user.id);
                          patchGroup(definition.key, { selectedUserIds: next });
                        }}
                      />
                      <span className="font-medium">{user.displayName}</span>
                      <span className="text-muted-foreground">{user.email}</span>
                      <span className="ml-auto text-xs uppercase text-muted-foreground">{user.role}</span>
                    </label>
                  ))}
                </div>
                <Button className="mt-4" onClick={() => void save(definition)} disabled={state.saving}>
                  {state.saving ? "Saving..." : "Save recipients"}
                </Button>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
