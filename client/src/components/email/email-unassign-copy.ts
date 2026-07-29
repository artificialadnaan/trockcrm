/**
 * The words the user sees when unassigning an email conversation from a deal, in ONE place.
 *
 * There are two entry points to this mutation and they are one click apart: the row action on the deal
 * Emails tab (deal-email-tab.tsx) and the Detach button inside the thread view (email-thread-view.tsx)
 * you land on by clicking that same row. They fire the same request against the same route, so a
 * confirmation on one and not the other — or two different success messages — reads as a bug rather
 * than as two features.
 *
 * The confirmation's second sentence is a factual claim about where the conversation goes, and it is
 * true only because detachConversationAcrossMailboxes clears the MESSAGE columns the assignment queue
 * selects on (assignment_status / assignment_ambiguity_reason), not just the thread binding. If that
 * ever narrows back to bindings alone, this sentence becomes a lie — pinned server-side by
 * server/tests/modules/email/thread-detach-message-side.runtime.test.ts.
 */
export const UNASSIGN_CONFIRMATION =
  "Unassign this conversation from the deal? It returns to the assignment queue until someone files it again.";

export const UNASSIGN_SUCCESS = "Conversation unassigned";

/**
 * Why a message with no graph_conversation_id cannot be unassigned at all: every detach route is keyed
 * on the conversation id, and there is no single-message equivalent. Saying so beats firing a request
 * that resolves to an encoded "null".
 */
export const UNASSIGN_UNAVAILABLE_NO_CONVERSATION =
  "This message isn't part of a tracked conversation, so it can't be unassigned from here.";
