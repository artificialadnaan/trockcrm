import express, { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { processSyncHubProcoreProjectCreated } from "./procore-project-relay-service.js";
import { processSyncHubProcoreProjectStageChanged } from "./procore-project-stage-relay-service.js";
import {
  SYNCHUB_RELAY_SIGNATURE_HEADER,
  verifySyncHubRelaySignature,
} from "./relay-signature.js";

export const syncHubProcoreRelayRoutes = Router();

function isReceiverEnabled(): boolean {
  return process.env.SYNCHUB_RELAY_RECEIVER_ENABLED !== "false";
}

function verifyAndParsePayload(rawBody: unknown, signature: string | undefined): unknown {
  if (!Buffer.isBuffer(rawBody)) {
    throw new AppError(400, "Expected application/json request body");
  }

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
    throw new AppError(401, "Invalid signature");
  }

  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new AppError(400, "Invalid JSON");
  }
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

      const rawBody = req.body;
      const signature = req.get(SYNCHUB_RELAY_SIGNATURE_HEADER) ?? undefined;
      const payload = verifyAndParsePayload(rawBody, signature);

      const result = await processSyncHubProcoreProjectCreated(payload);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

syncHubProcoreRelayRoutes.post(
  "/procore-project-stage-changed",
  express.raw({ type: "application/json" }),
  async (req, res, next) => {
    try {
      if (!isReceiverEnabled()) {
        res.status(503).json({ error: { message: "relay receiver disabled" } });
        return;
      }

      const rawBody = req.body;
      const signature = req.get(SYNCHUB_RELAY_SIGNATURE_HEADER) ?? undefined;
      const payload = verifyAndParsePayload(rawBody, signature);

      const result = await processSyncHubProcoreProjectStageChanged(payload);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);
