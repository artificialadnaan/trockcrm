# Codex Findings PR 284 / PR 285 Diagnosis

Generated: 2026-05-12
Branch: `fix/codex-findings-pr284-pr285`

## Finding 284-1 - `Other` lead source drops legacy source

Root cause: `server/src/modules/leads/source-control.ts` resolves display values by returning only `sourceDetail` when `sourceCategory === "Other"`. Legacy/migrated rows can have `sourceCategory = "Other"` with blank detail while still retaining the older `source` field. Lead conversion uses this resolver through `resolveSourceLeadLineage`, so those rows convert with `source = null`.

Chosen fix: keep the `Other` detail first, then fall back to the trimmed legacy `source`, then `null`. This preserves newer structured source detail without losing legacy values.

## Finding 284-2 - `creationContext: "migration"` is half-wired

Root cause: `resolveDealCreationPolicy` already treats `input.creationContext === "migration"` as migration origin, but `createDeal` later enforces company/property presence with `!input.migrationMode`. A caller using only the new context flag passes policy and then fails the old guard.

Chosen fix: compute `isMigration = input.migrationMode || input.creationContext === "migration"` in `createDeal` and use that for the company/property guard.

## Finding 284-3 - Direct-created deals cannot be edited

Root cause: PR #284 made direct deal creation without `sourceLeadId` valid when company/property are present, but `updateDeal` still blocks every existing deal where `sourceLeadId` is null unless `migrationMode === true`. The PATCH route explicitly deletes `migrationMode` before calling `updateDeal`, so UI/API edits for newly-created direct deals always fail.

Source-lead impact scan:
- Lead conversion, activity mirroring, file lineage, photo timeline filters, properties summaries, and post-conversion enrichment all treat missing `sourceLeadId` as a nullable lineage condition.
- The only edit blocker is the legacy `updateDeal` guard.
- Immutability still protects existing source leads, company IDs, and property IDs after this change.

Chosen fix: Option A. Remove the legacy null-`sourceLeadId` edit blocker. Direct-created deals are now a supported first-class record type and must be editable. Existing protections against clearing/changing source lead, company, or property remain.

## Finding 285-1 - `preview=1` bypasses download audit

Root cause: `shouldLogFileDownloadEvent(req.query)` returns false for client-supplied `preview=1` or `preview=true`, and the download route uses that to skip `downloaded` photo audit rows. Any authenticated client can fabricate the preview query and omit a real file access from audit history.

Chosen fix: always log photo download URL access. Preserve preview/download intent as metadata (`purpose: "preview" | "download"`) so reporting can filter if it needs to, but no client-controlled query suppresses the audit row.

## Finding 285-2 - Photo audit modal stale async race

Root cause: `openPhoto` awaits `/files/:id`, then may await a signed preview URL. There is no request identity or abort guard. If photo A is clicked and photo B is clicked before A resolves, A can still call `setSelectedPhoto`/`setSelectedPhotoUrl` after B.

Chosen fix: use an `AbortController` plus latest-request token in `PhotoAuditPage`. A new open aborts the previous fetch; state is only applied when the request is still current. The API helper already forwards `RequestInit`, so `signal` can be passed through.
