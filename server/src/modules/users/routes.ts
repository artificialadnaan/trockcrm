import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { getAccessibleOffices } from "../auth/service.js";
import { listUsers } from "../admin/users-service.js";
import { isCrmUserRole } from "../../middleware/field-auth.js";

const router = Router();

router.get("/crm-owners", async (req, res, next) => {
  try {
    const rows = (await listUsers()) as Array<{
      id: string;
      email: string;
      displayName: string;
      role: string;
      officeId: string | null;
      isActive: boolean;
    }>;

    await req.commitTransaction!();
    res.json({
      users: rows
        .filter((user) => user.isActive && isCrmUserRole(user.role))
        .map((user) => ({
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          officeId: user.officeId,
        })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/sales-reps", async (req, res, next) => {
  try {
    const purpose = typeof req.query.purpose === "string" ? req.query.purpose : undefined;
    const isDealReassignmentPicker = purpose === "deal-reassignment";

    if (req.user!.role === "rep" && !isDealReassignmentPicker) {
      await req.commitTransaction!();
      res.json({ users: [{ id: req.user!.id, displayName: req.user!.displayName, email: req.user!.email }] });
      return;
    }

    const requestedOfficeId = req.headers["x-office-id"] as string | undefined;
    const officeId = requestedOfficeId ?? req.user!.activeOfficeId ?? req.user!.officeId;
    const accessibleOffices = await getAccessibleOffices(
      req.user!.id,
      req.user!.role,
      req.user!.activeOfficeId ?? req.user!.officeId
    );

    if (requestedOfficeId && !accessibleOffices.some((office) => office.id === requestedOfficeId)) {
      throw new AppError(403, "Requested office is not accessible");
    }

    const rows = (await listUsers(officeId)) as Array<{
      id: string;
      email: string;
      displayName: string;
      role?: string;
      officeId: string | null;
      isActive: boolean;
    }>;
    await req.commitTransaction!();
    res.json({
      users: rows
        .filter((user) => user.isActive)
        .filter((user) =>
          isDealReassignmentPicker && "role" in user && typeof user.role === "string"
            ? isCrmUserRole(user.role)
            : true
        )
        // Do NOT re-filter to `user.officeId === officeId`. listUsers(officeId) already scopes the rows to
        // the active office via "office_id = officeId OR has a user_office_access grant to it", so a
        // primary-office-only filter STRIPS grant-holders — exactly the multi-office users the deal
        // reassignment (#748) and estimator (validateAssignee) backends ACCEPT, leaving valid candidates
        // un-pickable in the UI. The office scope is enforced in the SQL + the accessibleOffices check above.
        .map((user) => ({ id: user.id, displayName: user.displayName, email: user.email })),
    });
  } catch (err) {
    next(err);
  }
});

export { router as userRoutes };
