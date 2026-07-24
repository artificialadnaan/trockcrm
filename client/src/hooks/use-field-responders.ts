import { useCallback, useEffect, useRef, useState } from "react";
import { api, isApiError } from "@/lib/api";
import type {
  FieldResponder,
  FieldResponderAssignment,
  FieldResponderRole,
} from "@trock-crm/shared/types";

// Client bindings for the managed field-responder roster (server field-responders-routes.ts / migration 0198).
// Reads (list / assignments) are visible to any CRM role; writes (create / update / deactivate) are
// director/admin only server-side, so the roster page gates those controls on the current user's role.

/** The 409 code the create/update endpoints return when an ACTIVE row already holds the email (case-insensitive). */
export const FIELD_RESPONDER_EMAIL_DUPLICATE = "FIELD_RESPONDER_EMAIL_DUPLICATE";

/** True when the given error is the roster's duplicate-email 409 — callers surface a field-level message. */
export function isFieldResponderEmailDuplicate(error: unknown): boolean {
  return isApiError(error) && error.status === 409 && error.code === FIELD_RESPONDER_EMAIL_DUPLICATE;
}

export interface CreateFieldResponderInput {
  name: string;
  email: string;
  role: FieldResponderRole;
}

export interface UpdateFieldResponderInput {
  name?: string;
  email?: string;
  role?: FieldResponderRole;
  isActive?: boolean;
}

/** GET /api/field-responders?includeInactive=<bool> → the managed roster, each row with its live assignmentCount. */
export async function listFieldResponders(
  opts?: { includeInactive?: boolean },
): Promise<FieldResponder[]> {
  const qs = opts?.includeInactive ? "?includeInactive=true" : "";
  const res = await api<{ responders: FieldResponder[] }>(`/field-responders${qs}`);
  return res.responders;
}

/** POST /api/field-responders → 201 { responder }; throws the 409 duplicate on an active-email collision. */
export async function createFieldResponder(input: CreateFieldResponderInput): Promise<FieldResponder> {
  const res = await api<{ responder: FieldResponder }>("/field-responders", {
    method: "POST",
    json: { name: input.name, email: input.email, role: input.role },
  });
  return res.responder;
}

/** PATCH /api/field-responders/:id → { responder }; any subset of name/email/role/isActive. */
export async function updateFieldResponder(
  id: string,
  input: UpdateFieldResponderInput,
): Promise<FieldResponder> {
  const res = await api<{ responder: FieldResponder }>(`/field-responders/${id}`, {
    method: "PATCH",
    json: input,
  });
  return res.responder;
}

/** GET /api/field-responders/:id/assignments → the ACTIVE deals this responder is currently the super / PM on. */
export async function getFieldResponderAssignments(id: string): Promise<FieldResponderAssignment[]> {
  const res = await api<{ deals: FieldResponderAssignment[] }>(`/field-responders/${id}/assignments`);
  return res.deals;
}

export interface UseFieldResponders {
  responders: FieldResponder[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Load the managed roster. `includeInactive` surfaces deactivated people too (the roster page's "show inactive"
 * toggle). A monotonic request id keeps only the newest response — flipping the toggle quickly can leave several
 * requests in flight, and a slower older one must not clobber the current view.
 */
export function useFieldResponders(opts?: { includeInactive?: boolean }): UseFieldResponders {
  const includeInactive = opts?.includeInactive === true;
  const [responders, setResponders] = useState<FieldResponder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refetch = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await listFieldResponders({ includeInactive });
      if (requestId !== requestIdRef.current) return; // a newer request superseded this one
      setResponders(loaded);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to load the field-responder roster");
      setResponders([]);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [includeInactive]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { responders, loading, error, refetch };
}
