import "dotenv/config";

import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import path from "node:path";
import { authRouter } from "./routes/auth.js";
import { cleanupRouter } from "./routes/cleanup.js";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "3025", 10);
const clientDist = path.join(process.cwd(), "client", "dist");

app.use(helmet());
app.use(compression());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

function healthResponse(_req: express.Request, res: express.Response) {
  res.json({ status: "ok", service: "trock-onboarding-cleanup" });
}

app.get("/health", healthResponse);
app.get("/api/health", healthResponse);

app.use("/api/auth", authRouter);
app.use("/api/cleanup", cleanupRouter);

app.use(express.static(clientDist, {
  index: false,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
}));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  return res.sendFile(path.join(clientDist, "index.html"));
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(port, () => {
  console.log(`[cleanup] listening on :${port}`);
});
