# Lead Go/No-Go Approval Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a director/admin approval handoff when leads enter `Lead Go/No-Go`, while keeping rep recommendation context visible on the lead.

**Architecture:** Extend lead qualification data with rep recommendation fields, keep approval fields separate, emit office-scoped approval tasks and notifications on stage entry, and enforce the final approval transition on the server. Update the lead qualification UI so reps can recommend while only directors/admins can approve.

**Tech Stack:** TypeScript, React, Drizzle, Vitest

---

### Task 1: Lock the failing server behavior

**Files:**
- Modify: `server/tests/modules/leads/conversion-service.test.ts`
- Modify: `server/tests/modules/leads/qualification-service.test.ts`

- [ ] Add failing tests for:
  - approval tasks/notifications created when entering `Lead Go/No-Go`
  - rep cannot set `goDecision` or `goDecisionNotes`
  - rep cannot advance `Lead Go/No-Go` to `Qualified for Opportunity`
  - director/admin can approve and advance

### Task 2: Implement server-side approval handoff

**Files:**
- Modify: `shared/src/schema/tenant/lead-qualification.ts`
- Modify: `server/src/modules/leads/qualification-service.ts`
- Modify: `server/src/modules/leads/service.ts`
- Modify: `server/src/modules/leads/stage-gate.ts`
- Create: `migrations/0049_lead_go_no_go_approval_handoff.sql`

- [ ] Add recommendation fields to lead qualification storage
- [ ] Enforce role restrictions around approval fields
- [ ] Emit approval-request tasks and approval-needed notifications for office directors/admins
- [ ] Enforce director/admin-only advancement out of `Lead Go/No-Go`

### Task 3: Lock the failing client behavior

**Files:**
- Modify: `client/src/pages/leads/lead-detail-page.test.tsx`
- Modify: `client/src/pages/leads/lead-list-page.move.test.tsx`

- [ ] Add failing tests for:
  - rep sees recommendation fields but not editable approval controls
  - director/admin sees approval controls
  - blocked rep move shows approval-required message

### Task 4: Implement role-aware lead qualification UI

**Files:**
- Modify: `client/src/hooks/use-leads.ts`
- Modify: `client/src/components/leads/lead-qualification-panel.tsx`
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Modify: `client/src/components/leads/lead-stage-change-dialog.tsx`

- [ ] Add recommendation fields to client types
- [ ] Pass role context into the qualification panel
- [ ] Render approval status and approval controls with correct role gating
- [ ] Make the stage dialog explain the director/admin approval requirement

### Task 5: Verify

**Files:**
- None

- [ ] Run targeted lead server tests
- [ ] Run targeted lead client tests
- [ ] Run `npm run typecheck`
