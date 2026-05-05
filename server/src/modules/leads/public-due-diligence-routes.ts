import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import {
  publicDueDiligenceGetLimiter,
  publicDueDiligencePostLimiter,
} from "../../middleware/rate-limit.js";
import {
  decideDueDiligenceByToken,
  renderDueDiligenceNotFoundPage,
  renderDueDiligenceDecisionPage,
} from "./due-diligence-service.js";

const router = Router();

router.get("/", publicDueDiligenceGetLimiter, async (req, res, next) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const html = await renderDueDiligenceDecisionPage(token);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderDueDiligenceNotFoundPage());
      return;
    }
    next(err);
  }
});

router.post("/decide", publicDueDiligencePostLimiter, async (req, res, next) => {
  let token = "";
  try {
    token = typeof req.body?.token === "string" ? req.body.token : "";
    const decision = req.body?.decision === "approve" ? "approve" : req.body?.decision === "reject" ? "reject" : null;
    if (!decision) {
      throw new AppError(400, "Decision must be approve or reject");
    }

    const approval = await decideDueDiligenceByToken({
      token,
      decision,
      reason: typeof req.body?.reason === "string" ? req.body.reason : null,
    });
    const html = await renderDueDiligenceDecisionPage(token, {
      notice: `Decision recorded as ${approval.status}.`,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderDueDiligenceNotFoundPage());
      return;
    }
    if (err instanceof AppError && err.statusCode === 400) {
      try {
        const html = await renderDueDiligenceDecisionPage(token, { error: err.message });
        res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(html);
      } catch (renderErr) {
        if (renderErr instanceof AppError && renderErr.statusCode === 404) {
          res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
          res.send(renderDueDiligenceNotFoundPage());
          return;
        }
        next(renderErr);
      }
      return;
    }
    next(err);
  }
});

export const leadDueDiligencePublicRoutes = router;
