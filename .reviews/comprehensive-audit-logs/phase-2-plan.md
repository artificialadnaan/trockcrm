# Comprehensive Audit Logs — Phase 2 Plan

Date: 2026-05-14

## Scope Boundary

Phase 1 covered shared audit infrastructure plus lead/deal write surfaces only.

Phase 2 remains for:

- Properties
- Companies
- Contacts
- Tasks
- Files and photos
- Email
- Recordings
- Procore
- Bid Board
- CompanyCam
- Admin permission changes
- Merge and ownership tooling

## Proposed Order

1. Core CRM record surfaces
   - Properties
   - Companies
   - Contacts

2. User work surfaces
   - Tasks
   - Notes/comments
   - Files/photos
   - Email attachments/sends
   - Recordings

3. External system and automation surfaces
   - HubSpot sync events beyond lead/deal
   - Procore sync and webhook handlers
   - Bid Board operations
   - CompanyCam imports

4. Admin/system mutation surfaces
   - Role and office assignment changes
   - Merge queue resolution
   - Ownership queue/manual reassignment tooling

## Implementation Notes

- Reuse `logActivity(...)`, `field-formatters.ts`, and the shared denylist/redaction path from Phase 1.
- Keep `audit_log` as the canonical activity index.
- Preserve specialized legacy tables where they already power existing readers.
- Add actor propagation context to every user-driven service boundary instead of resolving from bare IDs late.
- Add system-process identities explicitly for every worker/webhook path. Never use the bare string `system`.

## Recommended Test Expansion

- Add one representative integration test per new write surface family.
- Extend the Phase 1 write-surface registry pattern into a Phase 2 registry.
- Add privacy tests for customer-safe filtering once customer-facing feeds start reading audit_log directly.

## Risks To Watch

- Contact/company/property merges can generate multi-record mutations; snapshot the acted-on record before merge side effects rewrite names.
- File/photo/email flows often create both metadata rows and join rows; log the user-facing event once at the attachment boundary.
- Webhook and worker paths can silently lose actor/process attribution if context is rebuilt piecemeal across async jobs.
- Admin ownership tooling is high-risk for scope creep because it touches lead/deal assignment indirectly; keep queue mechanics and audit wording isolated.
