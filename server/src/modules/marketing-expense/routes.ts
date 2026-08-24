import { Router, type NextFunction, type Request, type Response } from "express";
import {
  isMarketingExpenseApproverDecision,
  isMarketingExpenseStatus,
  type MarketingExpenseStatus,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { requireDirector } from "../../middleware/rbac.js";
import {
  createMarketingExpenseRequest,
  decideMarketingExpenseRequest,
  getMarketingExpenseRequest,
  listMarketingExpenseQueue,
  listMyMarketingExpenseRequests,
  submitMarketingExpenseRequest,
  withdrawMarketingExpenseRequest,
} from "./service.js";

const router = Router();

/**
 * Marketing & advertising expense requests.
 *
 * Mounted under the CRM-only tenant router, so `requireCrmUser` and the tenant transaction are already
 * applied by the time anything here runs.
 *
 * ON AUTHORIZATION — the queue and the decide endpoint guard on ROLE (`requireDirector` = admin|director),
 * not on membership of the `marketing_expense_approver` recipient group. That group is an email ROUTING
 * list. Approver-group authorization does not exist anywhere in this codebase — the closest analogue
 * (lead due diligence) guards its admin endpoints with `requireDirector` and uses its group only to address
 * mail — and the admin page that manages the group can only ever assign users who are already admin or
 * director, so a membership branch could not admit a single person this does not. Building a general
 * "is this user in group X" gate, plus generalizing the eligible-user filter so non-directors can be
 * assigned, is a feature with its own security surface; it is not a clone of an existing pattern and it is
 * not smuggled in here.
 */

/** Everything the approver queue can be filtered by. `draft` is deliberately absent: a draft has no
 *  approval row and belongs to nobody but its author. */
function parseQueueStatus(value: unknown): Exclude<MarketingExpenseStatus, "draft"> {
  if (value === undefined || value === null || value === "") return "pending";
  if (typeof value !== "string" || !isMarketingExpenseStatus(value) || value === "draft") {
    throw new AppError(400, "status must be pending, approved, denied or withdrawn.");
  }
  return value;
}

function requestId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError(400, "A request id is required.");
  return id;
}

// POST /api/marketing-expense-requests — create the DRAFT. Attachments upload against the returned id and
// POST /:id/submit is what makes it real. Any CRM user.
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = await createMarketingExpenseRequest(req.tenantDb!, {
      tenantSchema: `office_${req.officeSlug!}`,
      // The SESSION user, after the body has been read — a posted `submittedBy` is never consulted.
      userId: req.user!.id,
      input: req.body ?? {},
    });
    await req.commitTransaction!();
    res.status(201).json({ request });
  } catch (err) {
    next(err);
  }
});

// GET /api/marketing-expense-requests/mine — MUST be declared before /:id, or Express matches this path as
// a request id and the caller gets a 404 for a route that exists.
router.get("/mine", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requests = await listMyMarketingExpenseRequests(req.tenantDb!, req.user!.id);
    await req.commitTransaction!();
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

// GET /api/marketing-expense-requests — the approver queue.
router.get("/", requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = parseQueueStatus(req.query.status);
    const requests = await listMarketingExpenseQueue(req.tenantDb!, status);
    await req.commitTransaction!();
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

// GET /api/marketing-expense-requests/:id — submitter or admin/director. The check is in the service, with
// the row, because "is this yours" needs the row to answer.
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = await getMarketingExpenseRequest(req.tenantDb!, {
      requestId: requestId(req),
      user: { id: req.user!.id, role: req.user!.role },
    });
    await req.commitTransaction!();
    res.json({ request });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing-expense-requests/:id/submit — submitter, while draft.
router.post("/:id/submit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = await submitMarketingExpenseRequest(req.tenantDb!, {
      tenantSchema: `office_${req.officeSlug!}`,
      officeId: req.user!.activeOfficeId ?? null,
      userId: req.user!.id,
      requestId: requestId(req),
    });
    await req.commitTransaction!();
    res.json({ request });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing-expense-requests/:id/decide — admin/director. `:id` is the REQUEST; the service
// resolves which STEP the decision lands on.
router.post("/:id/decide", requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const decision = req.body?.decision;
    if (!isMarketingExpenseApproverDecision(decision)) {
      throw new AppError(400, "decision must be approved or denied.");
    }
    const request = await decideMarketingExpenseRequest(req.tenantDb!, {
      tenantSchema: `office_${req.officeSlug!}`,
      officeId: req.user!.activeOfficeId ?? null,
      requestId: requestId(req),
      userId: req.user!.id,
      decision,
      reason: typeof req.body?.reason === "string" ? req.body.reason : null,
    });
    await req.commitTransaction!();
    res.json({ request });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing-expense-requests/:id/withdraw — submitter, while pending.
router.post("/:id/withdraw", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = await withdrawMarketingExpenseRequest(req.tenantDb!, {
      requestId: requestId(req),
      userId: req.user!.id,
    });
    await req.commitTransaction!();
    res.json({ request });
  } catch (err) {
    next(err);
  }
});

export default router;
