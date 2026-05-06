import express, { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { processSyncHubProcoreProjectCreated } from "./procore-project-relay-service.js";
import {
  SYNCHUB_RELAY_SIGNATURE_HEADER,
  verifySyncHubRelaySignature,
} from "./relay-signature.js";

export const syncHubProcoreRelayRoutes = Router();

function isReceiverEnabled(): boolean {
  return process.env.SYNCHUB_RELAY_RECEIVER_ENABLED !== "false";
}

syncHubProcoreRelayRoutes.post(
  "/procore-project-created",
  express.raw({ type: "application/json" }),
  async (req, res, next) => {
    try {
      if (!isReceiverEnabled()) {
        res.status(503).json({ error: { message: "relay receiver disabled" } });
        return;
      }

      const rawBody = req.body as Buffer;
      const signature = req.get(SYNCHUB_RELAY_SIGNATURE_HEADER) ?? undefined;
      const signatureResult = verifySyncHubRelaySignature(
        rawBody,
        signature,
        process.env.SYNCHUB_RELAY_SECRET
      );

      if (signatureResult === "missing_secret") {
        throw new AppError(500, "relay receiver not configured");
      }
      if (signatureResult !== "valid") {
        console.warn(`[SyncHub:relay] Signature verification failed: ${signatureResult}`);
        res.status(401).json({ error: { message: "Invalid signature" } });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new AppError(400, "Invalid JSON");
      }

      const result = await processSyncHubProcoreProjectCreated(payload);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);
