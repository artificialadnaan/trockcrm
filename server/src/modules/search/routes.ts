import { Router, type Request, type Response } from "express";
import { globalSearch, naturalLanguageSearch } from "./service.js";
import { recordAiFeedback } from "../ai-copilot/service.js";

const router = Router();
const SEARCH_INTERACTION_TYPES = new Set([
  "search_impression",
  "recommended_action_click",
  "recommended_action_executed",
  "top_entity_click",
  "evidence_click",
]);

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

    const results = await globalSearch(
      req.tenantDb!,
      q,
      types,
      req.user?.role,
      req.user?.id,
    );
    await req.commitTransaction!();
    return res.json(results);
  } catch (err) {
    console.error("[search] Error:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

router.get("/ai", async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string ?? "").trim();
    if (q.length < 2) {
      return res.status(200).json({
        query: q,
        queryId: "00000000-0000-0000-0000-000000000000",
        intent: "general_search",
        summary: "",
        structured: { deals: [], contacts: [], files: [], total: 0, query: q },
        topEntities: [],
        recommendedActions: [],
        evidence: [],
      });
    }

    const typesParam = req.query.types as string | undefined;
    const types = typesParam
      ? (typesParam.split(",").filter((t) =>
          ["deals", "contacts", "files"].includes(t)
        ) as Array<"deals" | "contacts" | "files">)
      : (["deals", "contacts", "files"] as Array<"deals" | "contacts" | "files">);

    const results = await naturalLanguageSearch(
      req.tenantDb!,
      q,
      types,
      req.user?.role,
      req.user?.id,
    );
    await req.commitTransaction!();
    return res.json(results);
  } catch (err) {
    console.error("[search:ai] Error:", err);
    return res.status(500).json({ error: "AI search failed" });
  }
});

router.post("/ai/interaction", async (req: Request, res: Response) => {
  try {
    const queryId = typeof req.body?.queryId === "string" ? req.body.queryId : "";
    const interactionType = typeof req.body?.interactionType === "string" ? req.body.interactionType : "";
    const targetValue = typeof req.body?.targetValue === "string" ? req.body.targetValue : "";
    const deepLink = typeof req.body?.deepLink === "string" ? req.body.deepLink : null;
    const executionMode = typeof req.body?.executionMode === "string" ? req.body.executionMode : null;
    const apiEndpoint = typeof req.body?.apiEndpoint === "string" ? req.body.apiEndpoint : null;
    const queryContext = req.body?.queryContext && typeof req.body.queryContext === "object" ? req.body.queryContext : null;

    if (!queryId || !interactionType || !targetValue || !req.user?.id) {
      return res.status(400).json({ error: "queryId, interactionType, and targetValue are required" });
    }
    if (!SEARCH_INTERACTION_TYPES.has(interactionType)) {
      return res.status(400).json({ error: "Invalid AI search interaction type" });
    }

    const feedback = await recordAiFeedback(req.tenantDb!, {
      targetType: "search_query",
      targetId: queryId,
      userId: req.user.id,
      feedbackType: "search_interaction",
      feedbackValue: interactionType,
      comment: JSON.stringify({
        targetValue,
        deepLink,
        ...(executionMode ? { executionMode } : {}),
        ...(apiEndpoint ? { apiEndpoint } : {}),
        ...(queryContext ? { queryContext } : {}),
      }),
    });

    await req.commitTransaction!();
    return res.status(201).json({ interaction: feedback });
  } catch (err) {
    console.error("[search:ai:interaction] Error:", err);
    return res.status(500).json({ error: "AI search interaction tracking failed" });
  }
});

export { router as searchRoutes };
