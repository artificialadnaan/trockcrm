import { Router, type Request, type Response, type NextFunction } from "express";
import { getObjectStream, headObject } from "../../lib/r2-client.js";
import { AppError } from "../../middleware/error-handler.js";
import { SIGNATURE_LOGO_MAX_BYTES } from "./signature-logo.js";

const router = Router();

const EXT_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// <uuid>.<ext> — strict: no "/" or ".." can match, so path traversal is impossible by construction.
const ASSET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|gif|webp)$/i;

/**
 * Public, unauthenticated, PERMANENT serve of a signature logo from R2 (R2 has no public URL of its
 * own, and presigned URLs expire — an email opened weeks later needs a stable image). Serves ONLY
 * `signature-logos/<userId>/<asset>` keys built from STRICTLY validated params: the userId must be a
 * uuid and the asset must be `<uuid>.<ext>`, so the regexes reject traversal (no "/"/"..") and any
 * non-image path — nothing outside `signature-logos/` is reachable. Content-addressed filename ⇒
 * immutable long cache; content-type forced by extension (never the stored type) + nosniff; CORP
 * cross-origin so email clients (a different origin than the API) render the <img>. (#713 pattern.)
 */
router.get("/:userId/:asset", async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Express 5 types params as string | string[]; coerce defensively (an array won't match anyway).
    const userId = String(req.params.userId ?? "");
    const asset = String(req.params.asset ?? "");
    if (!UUID_RE.test(userId) || !ASSET_RE.test(asset)) {
      throw new AppError(404, "Not found");
    }
    const ext = asset.slice(asset.lastIndexOf(".") + 1).toLowerCase();
    const contentType = EXT_CONTENT_TYPE[ext];
    if (!contentType) throw new AppError(404, "Not found");

    const r2Key = `signature-logos/${userId}/${asset}`;

    // Serve-time size enforcement — the authoritative guard. The /confirm size-check is point-in-time:
    // a presigned PUT can overwrite the object afterward, and the key is predictable + confirm is
    // skippable, so the serve path itself must refuse anything over the cap (or missing). Never trust
    // that the object was confirmed or is still within size. (Codex #737.)
    const head = await headObject(r2Key);
    if (!head || (head.contentLength ?? 0) > SIGNATURE_LOGO_MAX_BYTES) {
      throw new AppError(404, "Not found");
    }

    let object: Awaited<ReturnType<typeof getObjectStream>>;
    try {
      object = await getObjectStream(r2Key);
    } catch {
      throw new AppError(404, "Not found");
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // No Content-Length: we hard-cap the relayed bytes below, so a declared length could mismatch.

    // THE guarantee: bound the stream itself. headObject is check-then-act — the object can be
    // overwritten via the still-valid presigned PUT between HEAD and GET — so we never relay more than
    // the cap regardless of the object's real size: stop + end the moment the next chunk would cross
    // it. (Codex #737, follow-up.) Relaying past the cap is impossible no matter what R2 returns.
    let relayed = 0;
    try {
      for await (const chunk of object.stream as AsyncIterable<Uint8Array>) {
        if (relayed + chunk.length > SIGNATURE_LOGO_MAX_BYTES) {
          res.end(); // truncate — never serve past the cap
          return;
        }
        relayed += chunk.length;
        if (!res.write(chunk)) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch {
      // Mid-stream R2 error: 404 if nothing sent yet, else end the (partial) response so it doesn't hang.
      if (!res.headersSent) res.status(404).end();
      else res.end();
    }
  } catch (err) {
    next(err);
  }
});

export { router as signatureLogoPublicRoutes };
