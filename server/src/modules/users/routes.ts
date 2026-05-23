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
    if (req.user!.role === "rep") {
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
      isActive: boolean;
    }>;
    res.json({
      users: rows
        .filter((user) => user.isActive)
        .map((user) => ({ id: user.id, displayName: user.displayName, email: user.email })),
    });
  } catch (err) {
    next(err);
  }
});

export { router as userRoutes };
