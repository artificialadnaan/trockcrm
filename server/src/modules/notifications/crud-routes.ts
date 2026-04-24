import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
} from "./service.js";

const router = Router();

router.use((_req, res, next) => {
  // Notification APIs are consumed by the production frontend from a sibling
  // Railway origin, so Helmet's default same-origin CORP is too strict here.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

// GET /api/notifications/list -- get notifications for current user
router.get("/list", async (req, res, next) => {
  try {
    const filters = {
      userId: req.user!.id,
      isRead: req.query.isRead === "true" ? true : req.query.isRead === "false" ? false : undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getNotifications(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/unread-count -- get unread count
router.get("/unread-count", async (req, res, next) => {
  try {
    const count = await getUnreadCount(req.tenantDb!, req.user!.id);
    await req.commitTransaction!();
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/:id/read -- mark single notification as read
router.post("/:id/read", async (req, res, next) => {
  try {
    const notification = await markAsRead(req.tenantDb!, req.params.id, req.user!.id);
    if (!notification) throw new AppError(404, "Notification not found");
    await req.commitTransaction!();
    res.json({ notification });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/read-all -- mark all notifications as read
router.post("/read-all", async (req, res, next) => {
  try {
    const count = await markAllAsRead(req.tenantDb!, req.user!.id);
    await req.commitTransaction!();
    res.json({ markedRead: count });
  } catch (err) {
    next(err);
  }
});

export const notificationCrudRoutes = router;
