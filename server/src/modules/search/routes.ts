import { Router, type Request, type Response } from "express";
import { globalSearch } from "./service.js";

const router = Router();

/**
 * GET /search?q=<query>&types=deals,contacts,files
 * Minimum 2 characters. Returns grouped results by entity type.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string ?? "").trim();
    if (q.length < 2) {
      return res.status(200).json({
        deals: [], contacts: [], files: [], total: 0, query: q,
      });
    }

    const typesParam = req.query.types as string | undefined;
    const types = typesParam
      ? (typesParam.split(",").filter((t) =>
          ["deals", "contacts", "files"].includes(t)
        ) as Array<"deals" | "contacts" | "files">)
      : (["deals", "contacts", "files"] as Array<"deals" | "contacts" | "files">);

    const results = await globalSearch(req.tenantDb!, q, types);
    await req.commitTransaction!();
    return res.json(results);
  } catch (err) {
    console.error("[search] Error:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

export { router as searchRoutes };
