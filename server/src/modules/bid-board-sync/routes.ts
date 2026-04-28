import crypto from "crypto";
import express, { Router } from "express";
import { ingestBidBoardRows } from "./service.js";

export const bidBoardSyncRoutes = Router();

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env.BID_BOARD_SYNC_SECRET;
  if (!secret || !signatureHeader) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.replace(/^sha256=/, "");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

bidBoardSyncRoutes.post(
  "/ingest",
  express.raw({ type: "application/json", limit: "25mb" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body as Buffer;
      const signature = req.headers["x-bid-board-sync-signature"] as string | undefined;

      if (!verifySignature(rawBody, signature)) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.status(400).json({ error: "Invalid JSON" });
        return;
      }

      const result = await ingestBidBoardRows(payload as never);
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  }
);
