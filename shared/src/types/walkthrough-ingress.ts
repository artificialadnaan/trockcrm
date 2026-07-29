/** One scope row produced by a walkthrough, before it becomes an estimate_extraction. */
export interface WalkthroughScopeRow {
  /** Stable id of the source scope_item in trock-scope. Used for export idempotency. */
  sourceScopeItemId: string;
  rawLabel: string;
  trade: string;
  divisionHint: string | null;
  /** Only ever set when the quantity was spoken and human-confirmed. Nullable because that is what
   *  the EXPORTER's rows look like — but a null one is REFUSED at ingress
   *  (validateWalkthroughIngressPayload), because downstream a null quantity is priced as one unit. */
  quantity: number | null;
  unit: string | null;
  /** 0-1 scale, matching extraction-service.ts:62. */
  confidence: number;
  /** Verbatim transcript utterance. */
  evidenceText: string;
  /** Temporal evidence — occupies the evidenceBboxJson column. */
  evidence: {
    clipId: string;
    timelineMs: number;
    frameKey: string | null;
  };
  locationLabel: string | null;
}

/**
 * Everything needed to build the synthetic document chain plus its rows.
 *
 * NOTE — there is deliberately NO contact-sheet R2 KEY here, and there must never be one. The key the
 * `files` row is stamped with is what `buildFileDownloadUrlFromRecord` presigns, and it authorizes on
 * the row's DEAL association rather than on the key itself. A caller-supplied key is therefore a
 * confused-deputy read primitive: an authenticated user who knows any key in the bucket could alias it
 * onto a deal they legitimately access and download an object they were never entitled to. Validation
 * cannot close that — an attacker supplies a perfectly well-formed key — so the key is DERIVED from
 * `walkthroughId` server-side (`deriveWalkthroughContactSheetR2Key`, walkthrough-ingress-service.ts).
 * The bucket, byte count and mime type stay on the wire: none of them can address a foreign object.
 */
export interface WalkthroughIngressPayload {
  walkthroughId: string;
  dealId: string;
  projectId: string | null;
  contactSheetBucket: string;
  contactSheetBytes: number;
  /** image/jpeg or application/pdf — the only families the estimating path accepts. */
  contactSheetMimeType: "image/jpeg" | "application/pdf";
  siteLabel: string;
  capturedAt: string;
  userId: string;
  rows: WalkthroughScopeRow[];
}

export interface WalkthroughIngressResult {
  documentId: string;
  parseRunId: string;
  fileId: string;
  extractionIds: string[];
}
