import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { requireAdmin, requireDirector } from "../../middleware/rbac.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import {
  listOffices, getOfficeById, createOffice, updateOffice,
} from "./offices-service.js";
import {
  getUsersWithStats, getUserById, updateUser, grantOfficeAccess, revokeOfficeAccess,
} from "./users-service.js";
import {
  listPipelineStages, updatePipelineStage, reorderPipelineStages,
} from "./pipeline-service.js";
import { getAuditLog, getAuditLogTables } from "./audit-service.js";

const router = Router();
router.use(authMiddleware);

// ---------------------------------------------------------------------------
// Offices (admin only)
// ---------------------------------------------------------------------------

router.get("/admin/offices", requireAdmin, async (req: Request, res: Response) => {
  try {
    const officeList = await listOffices();
    return res.json({ offices: officeList });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get("/admin/offices/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const office = await getOfficeById(req.params.id as string);
    if (!office) return res.status(404).json({ error: "Office not found" });
    return res.json({ office });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post("/admin/offices", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, slug, address, phone } = req.body as {
      name: string;
      slug: string;
      address?: string;
      phone?: string;
    };
    if (!name || !slug) return res.status(400).json({ error: "name and slug required" });
    const office = await createOffice({ name, slug, address, phone });
    return res.status(201).json({ office });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? String(err) });
  }
});

router.patch("/admin/offices/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const office = await updateOffice(req.params.id as string, req.body);
    return res.json({ office });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? String(err) });
  }
});

// ---------------------------------------------------------------------------
// Users (admin only)
// ---------------------------------------------------------------------------

router.get("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  try {
    const userList = await getUsersWithStats();
    return res.json({ users: userList });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = await getUserById(req.params.id as string);
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ user });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.patch("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = await updateUser(req.params.id as string, req.body);
    return res.json({ user });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? String(err) });
  }
});

router.post("/admin/users/:id/office-access", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { officeId, roleOverride } = req.body as {
      officeId: string;
      roleOverride?: "admin" | "director" | "rep";
    };
    if (!officeId) return res.status(400).json({ error: "officeId required" });
    await grantOfficeAccess(req.params.id as string, officeId, roleOverride);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.delete(
  "/admin/users/:id/office-access/:officeId",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      await revokeOfficeAccess(req.params.id as string, req.params.officeId as string);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }
);

// ---------------------------------------------------------------------------
// Pipeline config (admin only)
// ---------------------------------------------------------------------------

router.get("/admin/pipeline", requireAdmin, async (req: Request, res: Response) => {
  try {
    const stages = await listPipelineStages();
    return res.json({ stages });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.patch("/admin/pipeline/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const stage = await updatePipelineStage(req.params.id as string, req.body);
    return res.json({ stage });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? String(err) });
  }
});

router.post("/admin/pipeline/reorder", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { orderedIds } = req.body as { orderedIds: string[] };
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: "orderedIds required" });
    await reorderPipelineStages(orderedIds);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Audit log (admin + director, requires tenant context)
// ---------------------------------------------------------------------------

router.get(
  "/admin/audit",
  requireDirector,
  tenantMiddleware,
  async (req: Request, res: Response) => {
    try {
      const {
        tableName, recordId, changedBy, action, fromDate, toDate, page, limit,
      } = req.query as Record<string, string>;

      const result = await getAuditLog(req.tenantDb!, {
        tableName: tableName || undefined,
        recordId: recordId || undefined,
        changedBy: changedBy || undefined,
        action: action as any || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 50,
      });

      await req.commitTransaction!();
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }
);

router.get(
  "/admin/audit/tables",
  requireDirector,
  tenantMiddleware,
  async (req: Request, res: Response) => {
    try {
      const tables = await getAuditLogTables(req.tenantDb!);
      await req.commitTransaction!();
      return res.json({ tables });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }
);

export { router as adminRoutes };
