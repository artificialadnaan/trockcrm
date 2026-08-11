import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmailList } from "./email-list";
import { EmailComposeDialog } from "./email-compose-dialog";
import { EmailManualAssignmentDialog } from "./email-manual-assignment-dialog";
import { GraphAuthBanner } from "./graph-auth-banner";
import {
  UNASSIGN_CONFIRMATION,
  UNASSIGN_SUCCESS,
  UNASSIGN_UNAVAILABLE_NO_CONVERSATION,
} from "./email-unassign-copy";
import {
  associateEmailToEntity,
  detachEmailThread,
  reassignEmailThread,
  useDealEmails,
  useEmailThread,
  type Email,
  type EmailAssociationTarget,
} from "@/hooks/use-emails";

interface DealEmailTabProps {
  dealId: string;
  primaryContactEmail?: string | null;
}

// Module-level so the picker gets a STABLE reference. Its search effect lists the search types among
// its deps, so a fresh array literal on every parent render would restart the debounce each time.
const REASSIGN_SEARCH_TYPES: EmailAssociationTarget["assignedEntityType"][] = ["deal"];

/**
 * What the user is told a reassign will actually DO, before they pick a deal.
 *
 * A reassign moves the whole CONVERSATION, not the row they clicked, so the count is the point: it is
 * the difference between filing one stray reply and silently moving a fortnight of correspondence off
 * a deal. `messageCount` comes from the thread payload, which the server dedupes across per-mailbox
 * copies, so it counts real messages rather than rows.
 *
 * The no-conversation case says so instead of moving silently. 31 of ~10k production messages carry a
 * null graphConversationId, and those move ALONE via the single-message associate route — the opposite
 * blast radius from every other row in the list, which is exactly why it has to be stated.
 *
 * It also carries a PERMISSIONS warning the thread case does not need. This whole feature exists so a
 * deal collaborator can fix a misfiled email, and the thread routes were widened to allow exactly that
 * — but POST /api/email/:id/associate, the route the no-conversation fallback uses, still hard-gates on
 * `email.userId !== req.user.id` in both its route and its service. So the identical-looking menu item
 * is mailbox-owner-only for these 31 messages. It fails readably (a 403 the handler toasts), but a
 * dialog that promised the move without mentioning who can make it would be promising something the
 * server will refuse. Widening that gate is a separate decision; describing it honestly is not.
 */
function describeReassignImpact(email: Email | null, messageCount: number | null): string {
  if (!email) return "";
  if (!email.graphConversationId) {
    return (
      "This message isn't part of a tracked conversation — only it will move, not a whole thread. " +
      "Single messages can only be moved by the mailbox they belong to."
    );
  }
  if (messageCount === null) {
    return "Moves this whole conversation to the deal you pick, so future replies land there too.";
  }
  return `Moves ${messageCount} ${messageCount === 1 ? "message" : "messages"} to the deal you pick, so future replies land there too.`;
}

export function DealEmailTab({ dealId, primaryContactEmail }: DealEmailTabProps) {
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);
  const [reassignEmail, setReassignEmail] = useState<Email | null>(null);

  useEffect(() => {
    setPage(1);
  }, [dealId]);

  const { emails, pagination, loading, error, refetch } = useDealEmails(dealId, {
    page,
    limit: 20,
  });

  // CLAMP the page back into range whenever the collection shrinks under it.
  //
  // Reassigning or unassigning the last conversation on the last page takes a page off the end, and a
  // refetch of the SAME page then asks the server for one that no longer exists: it answers an empty
  // list and a lower totalPages, and EmailList takes its `emails.length === 0` early return before it
  // renders the pager — so the user is left on a blank tab with no control to get back. The clamp turns
  // that into a normal page.
  //
  // Deliberately a clamp and NOT setPage(1) on every move. Moving a conversation from page 1 is the
  // common case by far, and resetting there would remount the list and jump the scroll position every
  // time for no benefit. This fires only when the page currently being viewed is genuinely out of range.
  //
  // Keyed off `pagination`, not off the two handlers, so it covers both of them and anything else that
  // shrinks the list — nothing has to remember to call it. `totalPages` is 0 before the first response
  // lands, hence the floor of 1: page 1 is always legal.
  useEffect(() => {
    const lastPage = Math.max(1, pagination.totalPages);
    if (page > lastPage) setPage(lastPage);
  }, [page, pagination.totalPages]);

  // The thread of whatever row the picker is currently open for, read ONLY to tell the user how much
  // moves. `graphConversationId` is nullable and the thread routes are keyed on it, so a null one
  // means "no thread to size" and the hook is deliberately handed undefined rather than a fabricated
  // id (it then fetches nothing).
  const reassignConversationId = reassignEmail?.graphConversationId ?? undefined;
  const { thread } = useEmailThread(reassignConversationId);

  // useEmailThread keeps its last payload when the conversation id goes away, so trust the count only
  // while it demonstrably belongs to the row now selected — otherwise reopening the picker on a
  // different email would quote the PREVIOUS thread's size for a render.
  const threadMessageCount =
    reassignConversationId !== undefined &&
    thread.emails.length > 0 &&
    thread.emails[0].graphConversationId === reassignConversationId
      ? thread.emails.length
      : null;

  const reassignDescription = describeReassignImpact(reassignEmail, threadMessageCount);

  async function handleUnassign(email: Email) {
    if (!email.graphConversationId) {
      toast.error(UNASSIGN_UNAVAILABLE_NO_CONVERSATION);
      return;
    }

    if (!window.confirm(UNASSIGN_CONFIRMATION)) {
      return;
    }

    try {
      await detachEmailThread(email.graphConversationId);
      toast.success(UNASSIGN_SUCCESS);
      refetch();
    } catch (err: unknown) {
      // Includes the server's 403 for a caller who may not touch this thread; its message is written to
      // be read by a user, so show it rather than a generic failure.
      toast.error(err instanceof Error ? err.message : "Failed to unassign conversation");
    }
  }

  async function handleReassign(target: EmailAssociationTarget) {
    if (!reassignEmail) return;

    try {
      if (reassignEmail.graphConversationId) {
        // reassignEmailThread's second argument is a DEAL id. That is true of every target this picker
        // can produce only because REASSIGN_SEARCH_TYPES scopes it to deals, eighty lines away — so
        // check it here, where the call is, rather than let widening the picker quietly post a contact
        // id to a deal-keyed route. Throwing (not returning) keeps the picker open with the reason.
        if (target.assignedEntityType !== "deal") {
          throw new Error("A conversation can only be reassigned to a deal.");
        }
        const nextDealId = target.assignedDealId ?? target.assignedEntityId;
        // NO CLIENT-SIDE SAME-DEAL SHORT-CIRCUIT, and its absence is the decision.
        //
        // There used to be one, comparing nextDealId against `reassignEmail.dealId` — the deal on the
        // ROW the user clicked. That is the wrong scope for a conversation-wide operation. A binding is
        // per (mailbox, conversation) and an association is per MESSAGE, so a row filed on deal A proves
        // nothing about the other mailboxes' bindings or its own sibling messages: cross-filed across A
        // and B, or left split by a per-EMAIL reassign, picking A is a real CONSOLIDATION — and the
        // short-circuit answered it by closing the dialog with no request at all.
        //
        // Recomputing the condition from the thread payload was the other option and was rejected:
        // "is the whole conversation already on A" needs every binding and every message, and the
        // payload carries ONE binding, so the check would go on being a narrower question wearing the
        // answer to a wider one. The server mutation is idempotent and repairs exactly this split
        // (bindConversationToDealAcrossMailboxes reconciles even where it reuses a binding), so letting
        // it decide is both correct and incapable of drifting. It costs one request in the genuinely
        // redundant case, which is the cheap half of the trade.
        await reassignEmailThread(reassignEmail.graphConversationId, nextDealId);
        toast.success("Conversation reassigned");
      } else {
        await associateEmailToEntity(reassignEmail.id, target);
        toast.success("Email reassigned");
      }
      refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to reassign email");
      // Rethrown on purpose: the picker closes on a resolved onAssign and stays open with the message
      // inline when it rejects. Swallowing here would shut the dialog on a 403 and leave the toast as
      // the only trace that nothing moved.
      throw err;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Emails</h3>
        <Button size="sm" onClick={() => setComposeOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Compose
        </Button>
      </div>

      <GraphAuthBanner />

      <EmailList
        emails={emails}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        emptyMessage="No emails linked to this deal yet."
        onReassign={(email) => setReassignEmail(email)}
        onUnassign={(email) => void handleUnassign(email)}
        // The thread view renders in place of this list, so a move made in there has to invalidate the
        // same query the row actions invalidate — otherwise pressing Back shows the conversation still
        // filed under this deal.
        onThreadChanged={refetch}
      />

      <EmailManualAssignmentDialog
        open={reassignEmail !== null}
        onOpenChange={(open) => {
          if (!open) setReassignEmail(null);
        }}
        title="Reassign to another deal"
        description={reassignDescription}
        searchTypes={REASSIGN_SEARCH_TYPES}
        onAssign={handleReassign}
      />

      <EmailComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={refetch}
        defaultTo={primaryContactEmail ?? undefined}
        dealId={dealId}
      />
    </div>
  );
}
