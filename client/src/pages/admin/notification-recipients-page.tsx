import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  NOTIFICATION_RECIPIENT_GROUPS,
  type NotificationRecipientGroupDefinition,
} from "@trock-crm/shared/types";
import { Button } from "@/components/ui/button";
import { useAdminUsers, type AdminUser } from "@/hooks/use-admin-users";
import { useOfficeScopeId } from "@/hooks/use-office-scope";
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
 * WHO IS OFFERED is per group, not global. A mailing list should offer everyone: the bid due date report
 * goes to an estimator, whose role is `rep`, and the old admin/director-only picker is precisely why she
 * could not be named. A group whose membership is a PERMISSION must not widen with it — see
 * `assignableRoles` on the definition, which the server enforces independently.
 */

interface GroupState {
  recipients: NotificationRecipient[];
  selectedUserIds: Set<string>;
  fallbackApplied: boolean;
  error: string | null;
  loading: boolean;
  saving: boolean;
}

/** A FACTORY, not a shared constant — one `Set` handed to every key is one mutation away from a leak. */
function createInitialGroupState(): GroupState {
  return {
    recipients: [],
    selectedUserIds: new Set<string>(),
    fallbackApplied: false,
    error: null,
    loading: true,
    saving: false,
  };
}

function createInitialGroups(): Record<string, GroupState> {
  return Object.fromEntries(
    NOTIFICATION_RECIPIENT_GROUPS.map((definition) => [definition.key, createInitialGroupState()])
  );
}

/**
 * Who this group can offer, plus anyone already on it that the filters would otherwise hide.
 *
 * The second half is not a nicety. A recipient assigned to due diligence as a director and later moved to
 * rep — or simply offboarded — drops out of the list while remaining assigned, and the page keeps
 * submitting them, because it submits the membership it was given. With no checkbox there is no way to
 * take them off, so the configuration is frozen in exactly the state the rules exist to prevent. They are
 * drawn, flagged, and can be unticked; the server permits the removal and still refuses to re-add them.
 *
 * Takes ALL users rather than the active ones for that reason: a deactivated assignee has to be reachable.
 */
function pickerRowsFor(
  definition: NotificationRecipientGroupDefinition,
  allUsers: AdminUser[],
  selectedUserIds: Set<string>
): Array<{ user: AdminUser; assignable: boolean; currentOfficeRole: string | null }> {
  const allowed = definition.assignableRoles;
  /**
   * `role` is the home-office role used by the global Users page. Recipient groups live in the selected
   * office, so an admin grant that lifts a base rep here must be judged as admin — and a global admin who
   * has no access to this office must not be offered merely because of their base role.
   *
   * Older API responses did not carry `effectiveRole`; keep their existing base-role behavior while a
   * mixed deploy rolls through. An explicit `null` is different: it means the server established that this
   * user has no access to the selected office, so it must never fall back to the base role.
   */
  const currentOfficeRoleFor = (user: AdminUser) =>
    Object.prototype.hasOwnProperty.call(user, "effectiveRole")
      ? user.effectiveRole ?? null
      : user.role;
  const isAssignable = (user: AdminUser) => {
    const currentOfficeRole = currentOfficeRoleFor(user);
    return user.isActive && (!allowed || (currentOfficeRole !== null && allowed.includes(currentOfficeRole)));
  };
  return allUsers
    .filter((user) => isAssignable(user) || selectedUserIds.has(user.id))
    .map((user) => ({
      user,
      assignable: isAssignable(user),
      currentOfficeRole: currentOfficeRoleFor(user),
    }));
}

export function NotificationRecipientsPage() {
  const officeScopeId = useOfficeScopeId();
  const { users, loading: usersLoading } = useAdminUsers();
  const [groups, setGroups] = useState<Record<string, GroupState>>(createInitialGroups);
  /** The scope whose selections are in `groups`; a URL switch must never leave the old ids saveable. */
  const [groupsOfficeScopeId, setGroupsOfficeScopeId] = useState<string | null>(officeScopeId);
  const groupsMatchOfficeScope = groupsOfficeScopeId === officeScopeId;

  /**
   * Which effect run owns the in-flight requests.
   *
   * A single `cancelled` boolean does not survive StrictMode, which sets the effect up, tears it down and
   * sets it up again: the second setup resets the flag, so the FIRST run's outstanding responses come back
   * alive and overwrite the newer ones — or an edit the admin has already made. Bumping a counter on both
   * setup and teardown makes a superseded run permanently superseded.
   */
  const runId = useRef(0);
  /**
   * Saves in flight, by scope and key. A ref because two clicks can land before React re-renders — see
   * `save`. Scope belongs in the identity too: an old-office request must not block (or unlock) this
   * office's save button.
   */
  const savingKeys = useRef(new Set<string>());

  const patchGroup = useCallback((key: string, patch: Partial<GroupState>) => {
    setGroups((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }, []);

  const loadGroup = useCallback(
    async (key: string, run: number) => {
      patchGroup(key, { loading: true });
      try {
        const result = await getNotificationRecipientGroup(key);
        if (runId.current !== run) return;
        patchGroup(key, {
          recipients: result.recipients,
          // ASSIGNED, never the effective recipients. When a group falls back to admins and directors the
          // server sends both, and ticking the fallback would let any Save write it in as real rows — the
          // fallback then never fires again and a director hired next year silently stops receiving these.
          selectedUserIds: new Set(result.assignedUserIds),
          fallbackApplied: result.fallbackApplied,
          error: null,
          loading: false,
        });
      } catch (err) {
        if (runId.current !== run) return;
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
    const run = (runId.current += 1);
    // Reset before issuing the reads. The comparison below also covers the render immediately after the
    // URL changes, before this effect has had a chance to commit its reset.
    setGroupsOfficeScopeId(officeScopeId);
    setGroups(createInitialGroups());
    for (const definition of NOTIFICATION_RECIPIENT_GROUPS) {
      void loadGroup(definition.key, run);
    }
    return () => {
      runId.current += 1;
    };
  }, [loadGroup, officeScopeId]);

  const toggleRecipient = useCallback((key: string, userId: string, checked: boolean) => {
    if (!groupsMatchOfficeScope) return;
    // Computed INSIDE the updater. Reading `state.selectedUserIds` off the render closure works only
    // because React flushes discrete events one at a time, which is a fact about React, not about us.
    setGroups((current) => {
      const group = current[key];
      const next = new Set(group.selectedUserIds);
      if (checked) next.add(userId);
      else next.delete(userId);
      return { ...current, [key]: { ...group, selectedUserIds: next } };
    });
  }, [groupsMatchOfficeScope]);

  const save = async (definition: NotificationRecipientGroupDefinition) => {
    // The `disabled` attribute cannot stop a double-click that lands in one batch — both clicks are
    // dispatched before React re-renders, so the button is still enabled for the second. Neither can a
    // render-scoped `state.saving`, whose closure also still reads false. A ref is written immediately.
    if (!groupsMatchOfficeScope) return;
    const saveRun = runId.current;
    const saveKey = `${officeScopeId ?? ""}\u0000${definition.key}`;
    if (savingKeys.current.has(saveKey)) return;

    const selectedUserIds = [...groups[definition.key].selectedUserIds];
    if (selectedUserIds.length === 0) {
      const confirmed = window.confirm(`Save with no recipients? ${definition.emptyWarning}`);
      if (!confirmed) return;
    }

    savingKeys.current.add(saveKey);
    patchGroup(definition.key, { saving: true });
    try {
      const result = await updateNotificationRecipientGroup(definition.key, selectedUserIds);
      // A save started in Office A can finish after the route enters Office B. Its response describes
      // A and must not repaint B's freshly-reset group (nor claim success for the wrong tenant).
      if (runId.current !== saveRun) return;
      // `recipients` and `fallbackApplied` are adopted from the response because only the server can know
      // them — who is deliverable, and whether the group fell back. The SELECTION deliberately is not.
      //
      // The write persists exactly the ids that were sent, so re-adopting them changes nothing in the
      // ordinary case and loses data in the one case where it differs: an admin ticking another name while
      // the request is in flight had their edit silently reverted when the response landed. That is the
      // same "captured at one moment, applied at a later one" shape as the render-scoped snapshot above,
      // and the fix is to not do it rather than to detect it.
      patchGroup(definition.key, {
        recipients: result.recipients,
        fallbackApplied: result.fallbackApplied,
        saving: false,
      });
      toast.success("Notification recipients updated");
    } catch (err) {
      if (runId.current !== saveRun) return;
      patchGroup(definition.key, { saving: false });
      toast.error(
        err instanceof Error
          ? `Failed to update recipients: ${err.message}`
          : "Failed to update recipients. Please try again."
      );
    } finally {
      savingKeys.current.delete(saveKey);
    }
  };

  // Only the user list gates the whole page — without it there is nothing to tick. Each group draws its
  // own loading and error state, so one slow or broken key cannot take the others down with it.
  if (usersLoading) {
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
        // React renders a URL change before effects reset state. Treat a scope mismatch as loading in
        // that one render too, rather than briefly drawing Office A's recipient ids under Office B.
        const state = groupsMatchOfficeScope ? groups[definition.key] : createInitialGroupState();
        const headingId = `notification-group-${definition.key}`;
        return (
          <section
            key={definition.key}
            data-group-key={definition.key}
            aria-labelledby={headingId}
            className="border bg-background p-4"
          >
            <h2 id={headingId} className="font-semibold">{definition.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{definition.description}</p>

            {state.loading ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading recipients
              </div>
            ) : state.error ? (
              <div className="mt-4 space-y-3 border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <p>{state.error}</p>
                <Button variant="outline" onClick={() => { void loadGroup(definition.key, runId.current); }}>
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <p className="mt-1 text-sm text-muted-foreground">
                  {state.fallbackApplied ? "No one is assigned, so these currently go to: " : "Current recipients: "}
                  {state.recipients.length ? state.recipients.map((recipient) => recipient.email).join(", ") : "none"}
                </p>
                <div className="mt-4 grid gap-2">
                  {/* TODO: Replace checkbox list with autocomplete picker when user count
                      exceeds ~50. Current pattern is fine for the existing T Rock team size. */}
                  {pickerRowsFor(definition, users, state.selectedUserIds).map(({ user, assignable, currentOfficeRole }) => (
                    <label key={user.id} className="flex items-center gap-3 border p-3 text-sm">
                      <input
                        type="checkbox"
                        checked={state.selectedUserIds.has(user.id)}
                        onChange={(event) => toggleRecipient(definition.key, user.id, event.target.checked)}
                      />
                      <span className="font-medium">{user.displayName}</span>
                      <span className="text-muted-foreground">{user.email}</span>
                      {assignable ? null : (
                        <span className="text-xs text-red-700">no longer assignable — untick to remove</span>
                      )}
                      <span className="ml-auto text-xs uppercase text-muted-foreground">
                        {currentOfficeRole ?? user.role}
                      </span>
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
