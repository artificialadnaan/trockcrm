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

/** Everything needed to build the synthetic document chain plus its rows. */
export interface WalkthroughIngressPayload {
  walkthroughId: string;
  dealId: string;
  projectId: string | null;
  /** R2 key of the contact-sheet image standing in as the source document. */
  contactSheetR2Key: string;
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
