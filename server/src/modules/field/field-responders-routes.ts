import { Router } from "express";
import { requireDirector, requireAnyRole } from "../../middleware/rbac.js";
import { assertValidUuid } from "./photos-service.js";
import {
  listFieldResponders,
  createFieldResponder,
  updateFieldResponder,
  listFieldResponderAssignments,
} from "./field-responders-service.js";

// CRM routes for the field-responder roster (migration 0198). Mounted (in app.ts) under the tenant router at
// `/api/field-responders`, so each request already carries auth + tenant scope (req.tenantDb / the per-request
// office transaction that req.commitTransaction! commits). The roster LIST is visible to any CRM role
// (admin/director/rep) because the assign-from-roster picker on the deal Team tab needs to read it, and the
// per-row assignmentCount is a harmless aggregate. The per-deal assignment DRILL-DOWN, however, names specific
// deals across ALL reps, so it is director/admin only — a rep must not enumerate other reps' deals through the
// roster (they can't through the deals API either). Writes (create / update / deactivate) are likewise
// director/admin only — managing the roster is a leadership action, mirroring who curates the corrective-action
// recipient list this roster feeds.

const router = Router();

/** Parse ?includeInactive — only the literal string "true" opts in; anything else (absent, "false", junk) is off. */
function parseIncludeInactive(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "true";
}

// GET /api/field-responders?includeInactive=<bool> — the managed roster, each row with its live assignmentCount.
router.get("/", requireAnyRole, async (req, res, next) => {
  try {
    const includeInactive = parseIncludeInactive(req.query.includeInactive);
    const { responders } = await listFieldResponders(req.tenantDb!, { includeInactive });
    await req.commitTransaction!();
    res.json({ responders });
  } catch (err) {
    next(err);
  }
});

// POST /api/field-responders — add a roster person. 201 on create; 409 (FIELD_RESPONDER_EMAIL_DUPLICATE) when an
// ACTIVE row already holds the email (case-insensitive). Director/admin only.
router.post("/", requireDirector, async (req, res, next) => {
  try {
    const { name, email, role } = req.body ?? {};
    const responder = await createFieldResponder(req.tenantDb!, { name, email, role });
    await req.commitTransaction!();
    res.status(201).json({ responder });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/field-responders/:id — edit / deactivate a roster person (any subset of name/email/role/isActive).
// 404 unknown id; 409 on an active-email collision from a rename/reactivation. Director/admin only.
router.patch("/:id", requireDirector, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    assertValidUuid(id, "id");
    const { name, email, role, isActive } = req.body ?? {};
    const responder = await updateFieldResponder(req.tenantDb!, id, {
      name,
      email,
      role,
      isActive,
    });
    await req.commitTransaction!();
    res.json({ responder });
  } catch (err) {
    next(err);
  }
});

// GET /api/field-responders/:id/assignments — the ACTIVE deals this responder is currently the super / PM on
// (the drill-down behind assignmentCount). Director/admin only: it enumerates specific deals across all reps.
// 404 unknown id.
router.get("/:id/assignments", requireDirector, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    assertValidUuid(id, "id");
    const { deals } = await listFieldResponderAssignments(req.tenantDb!, id);
    await req.commitTransaction!();
    res.json({ deals });
  } catch (err) {
    next(err);
  }
});

export const fieldRespondersRoutes = router;
