import "dotenv/config";

import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { authRouter } from "./routes/auth.js";
import { cleanupRouter } from "./routes/cleanup.js";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "3025", 10);

app.use(helmet());
app.use(compression());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "trock-onboarding-cleanup" });
});

app.use("/api/auth", authRouter);
app.use("/api/cleanup", cleanupRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(port, () => {
  console.log(`[cleanup] listening on :${port}`);
});
