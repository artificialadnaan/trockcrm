# Plan 1: Foundation — Repo, Database, Auth, Multi-Office, Event Bus

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, database schema (public + per-office), authentication, multi-office tenancy middleware, event bus, job queue, and frontend shell — so all subsequent plans can build features on a working foundation.

**Architecture:** Modular monolith with domain events. Express API server with per-request DB transactions, schema-per-office routing via `SET LOCAL search_path`, and an internal event bus (EventEmitter for in-process, PG LISTEN/NOTIFY for cross-process). Separate Worker service polls the job queue and listens for PG notifications. React frontend with Vite, Tailwind, and shadcn/ui.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, React, Vite, Tailwind CSS, shadcn/ui, node-cron, jsonwebtoken, @azure/msal-node

**Spec Reference:** `docs/superpowers/specs/2026-04-01-trock-crm-design.md`

**Deployment:** GitHub repo → Railway (3 services: API :3001, Worker, Frontend :3000)

---

## File Structure

```
trock-crm/
├── package.json                    # Root workspace config
├── tsconfig.base.json              # Shared TypeScript config
├── .gitignore
├── .env.example
│
├── shared/
│   ├── package.json
│   ├── tsconfig.json               # composite: true for project references
│   ├── src/
│   │   ├── schema/
│   │   │   ├── index.ts            # Re-exports all schemas (public + tenant)
│   │   │   ├── public/
│   │   │   │   ├── offices.ts
│   │   │   │   ├── users.ts
│   │   │   │   ├── user-office-access.ts
│   │   │   │   ├── pipeline-stage-config.ts
│   │   │   │   ├── lost-deal-reasons.ts
│   │   │   │   ├── project-type-config.ts
│   │   │   │   ├── region-config.ts
│   │   │   │   ├── saved-reports.ts
│   │   │   │   ├── procore-sync-state.ts
│   │   │   │   ├── procore-webhook-log.ts
│   │   │   │   ├── user-graph-tokens.ts
│   │   │   │   └── job-queue.ts
│   │   │   └── tenant/
│   │   │       ├── deals.ts
│   │   │       ├── deal-stage-history.ts
│   │   │       ├── change-orders.ts
│   │   │       ├── deal-approvals.ts
│   │   │       ├── contacts.ts
│   │   │       ├── contact-deal-associations.ts
│   │   │       ├── duplicate-queue.ts
│   │   │       ├── emails.ts
│   │   │       ├── activities.ts
│   │   │       ├── files.ts
│   │   │       ├── tasks.ts
│   │   │       ├── notifications.ts
│   │   │       └── audit-log.ts
│   │   ├── types/
│   │   │   ├── index.ts            # Re-exports all types
│   │   │   ├── auth.ts             # JWT claims, user session
│   │   │   ├── events.ts           # Domain event type definitions
│   │   │   └── enums.ts            # Shared enum values
│   │   └── utils/
│   │       └── normalize.ts        # String normalization helpers
│   └── drizzle.config.ts
│
├── server/
│   ├── package.json
│   ├── tsconfig.json               # rootDir: "./src", for production build
│   ├── tsconfig.test.json          # extends tsconfig.json, rootDir: ".", includes tests
│   ├── src/
│   │   ├── index.ts                # Express app entry point
│   │   ├── app.ts                  # Express app setup (middleware, routes)
│   │   ├── db.ts                   # Drizzle client + connection pool
│   │   ├── middleware/
│   │   │   ├── auth.ts             # JWT validation + dev-mode picker
│   │   │   ├── tenant.ts           # Transaction + search_path + audit setter
│   │   │   ├── rbac.ts             # Role-based access control guards
│   │   │   ├── error-handler.ts    # Global error handler
│   │   │   └── rate-limit.ts       # express-rate-limit config
│   │   ├── events/
│   │   │   ├── bus.ts              # EventEmitter + PG NOTIFY wrapper
│   │   │   └── types.ts            # Event name constants
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   │   ├── routes.ts       # /api/auth/* routes
│   │   │   │   └── service.ts      # Token issuance, user lookup
│   │   │   ├── office/
│   │   │   │   ├── routes.ts       # /api/offices/* routes
│   │   │   │   └── service.ts      # Office CRUD, schema provisioning
│   │   │   └── notifications/
│   │   │       └── routes.ts       # SSE endpoint for real-time notifications
│   │   └── migrations/
│   │       └── runner.ts           # Per-schema migration runner
│   └── tests/
│       ├── setup.ts                # Test DB setup/teardown
│       ├── middleware/
│       │   ├── auth.test.ts
│       │   └── tenant.test.ts
│       ├── modules/
│       │   ├── auth.test.ts
│       │   └── office.test.ts
│       └── events/
│           └── bus.test.ts
│
├── worker/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                # Worker entry point
│       ├── db.ts                   # Drizzle client (shared config)
│       ├── listener.ts             # PG LISTEN handler
│       ├── queue.ts                # Job queue poller
│       └── jobs/
│           └── index.ts            # Job type registry + test_echo handler
│
├── client/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── postcss.config.js
│   ├── components.json             # shadcn/ui config (generated by shadcn init)
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                  # Router + auth context
│       ├── globals.css              # Generated by shadcn init, then customized
│       ├── lib/
│       │   ├── api.ts              # Fetch wrapper with auth
│       │   ├── auth.tsx            # Auth context + hooks
│       │   └── utils.ts            # cn() helper (generated by shadcn)
│       ├── components/
│       │   ├── ui/                  # shadcn/ui components (generated)
│       │   ├── layout/
│       │   │   ├── sidebar.tsx
│       │   │   ├── topbar.tsx
│       │   │   ├── mobile-nav.tsx
│       │   │   └── app-shell.tsx
│       │   └── auth/
│       │       ├── dev-user-picker.tsx
│       │       └── auth-callback.tsx
│       └── pages/
│           └── dashboard.tsx        # Placeholder dashboard
│
└── migrations/
    └── 0001_initial.sql             # Full public schema + default office schema
```

---

## Task 1: Repository Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- Create: `shared/package.json`, `shared/tsconfig.json`
- Create: `server/package.json`, `server/tsconfig.json`, `server/tsconfig.test.json`
- Create: `worker/package.json`, `worker/tsconfig.json`
- Create: `client/package.json`, `client/tsconfig.json`

- [ ] **Step 1: Initialize root package.json with workspaces**

```json
{
  "name": "trock-crm",
  "private": true,
  "workspaces": ["shared", "server", "worker", "client"],
  "scripts": {
    "dev:server": "npm run dev --workspace=server",
    "dev:shared": "npm run build --workspace=shared",
    "dev:worker": "npm run dev --workspace=worker",
    "dev:client": "npm run dev --workspace=client",
    "dev": "npm run dev:shared && concurrently \"npm:dev:shared -- --watch\" \"npm:dev:server\" \"npm:dev:worker\" \"npm:dev:client\"",
    "build": "npm run build --workspaces",
    "typecheck": "npm run typecheck --workspaces",
    "test": "npm run test --workspace=server",
    "db:generate": "drizzle-kit generate --config=shared/drizzle.config.ts",
    "db:migrate": "tsx server/src/migrations/runner.ts",
    "db:studio": "drizzle-kit studio --config=shared/drizzle.config.ts"
  },
  "devDependencies": {
    "concurrently": "^9.1.2",
    "typescript": "^5.7.3"
  }
}
```

> **Issue #1 fix:** Root `typecheck` script calls `npm run typecheck --workspaces` which delegates to each workspace's own `typecheck` script, not the nonexistent `tsc --noEmit --workspaces`.

- [ ] **Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "downlevelIteration": true
  }
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
.superpowers/
.omc/
```

- [ ] **Step 4: Create .env.example**

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trock_crm
DATABASE_PUBLIC_URL=postgresql://postgres:postgres@localhost:5432/trock_crm

# Auth - Microsoft Entra ID (leave empty for dev-mode user picker)
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_TENANT_ID=

# JWT
JWT_SECRET=dev-secret-change-in-production

# Encryption (for Graph/Procore token storage)
ENCRYPTION_KEY=dev-encryption-key-32-chars-long!

# Procore
PROCORE_CLIENT_ID=
PROCORE_CLIENT_SECRET=

# Cloudflare R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=trock-crm-files

# Email
RESEND_API_KEY=

# URLs
FRONTEND_URL=http://localhost:5173
API_URL=http://localhost:3001

# Environment
NODE_ENV=development
```

- [ ] **Step 5: Create shared/package.json**

```json
{
  "name": "@trock-crm/shared",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/schema/index.js",
  "exports": {
    "./schema": "./dist/schema/index.js",
    "./types": "./dist/types/index.js",
    "./utils": "./dist/utils/normalize.js"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "drizzle-orm": "^0.39.3",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "drizzle-kit": "^0.30.4",
    "@types/pg": "^8.11.10"
  }
}
```

> **Issue #2 fix:** Conditional exports so `tsx` (dev) resolves to `.ts` source and Node (production) resolves to compiled `.js` in `dist/`. The `build` script compiles shared for production.

- [ ] **Step 6: Create shared/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

> **Issue #3 fix:** `composite: true` is required for TypeScript project references. Without it, `references: [{ "path": "../shared" }]` in server/worker tsconfig files will fail.

- [ ] **Step 7: Create server/package.json**

```json
{
  "name": "@trock-crm/server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -b",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@trock-crm/shared": "*",
    "express": "^5.0.1",
    "drizzle-orm": "^0.39.3",
    "pg": "^8.13.1",
    "jsonwebtoken": "^9.0.2",
    "@azure/msal-node": "^3.3.0",
    "cors": "^2.8.5",
    "cookie-parser": "^1.4.7",
    "express-rate-limit": "^7.5.0",
    "dotenv": "^16.4.7"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/cors": "^2.8.17",
    "@types/cookie-parser": "^1.4.8",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2",
    "vitest": "^3.0.4"
  }
}
```

> **Issue #1 fix:** Each workspace has its own `typecheck` script.

- [ ] **Step 8: Create server/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../shared" }]
}
```

> **Issue #4 fix:** `tests/**/*` is NOT in this include. `rootDir: "./src"` only covers source files. Tests use a separate tsconfig (see next step).

- [ ] **Step 8b: Create server/tsconfig.test.json**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

> **Issue #4 fix:** Test tsconfig extends the main one but widens `rootDir` to `"."` and includes both `src/` and `tests/`. Vitest uses this config. The main `tsconfig.json` stays clean for production builds.

- [ ] **Step 9: Create worker/package.json**

```json
{
  "name": "@trock-crm/worker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -b",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@trock-crm/shared": "*",
    "drizzle-orm": "^0.39.3",
    "pg": "^8.13.1",
    "node-cron": "^3.0.3",
    "dotenv": "^16.4.7"
  },
  "devDependencies": {
    "@types/node-cron": "^3.0.11",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2"
  }
}
```

- [ ] **Step 10: Create worker/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 11: Install dependencies**

Run: `npm install`
Expected: All workspaces install successfully, no peer dependency errors.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo with shared, server, worker workspaces"
```

---

## Task 2: Frontend Scaffolding (Vite + React + Tailwind + shadcn/ui)

**Files:**
- Create: `client/vite.config.ts`, `client/postcss.config.js`
- Create: `client/index.html`
- Create: `client/src/main.tsx`, `client/src/App.tsx`
- shadcn init generates: `client/tailwind.config.ts`, `client/components.json`, `client/src/globals.css`, `client/src/lib/utils.ts`

**Important sequencing:** shadcn init creates its own `tailwind.config.ts` with CSS variable color mappings. We run shadcn init FIRST, then modify the generated config to add brand/sidebar colors. This avoids Issue #6 (missing CSS variable mappings).

- [ ] **Step 1: Initialize Vite React project in client/**

Run from repo root:
```bash
cd client && npm create vite@latest . -- --template react-ts
```

If prompted about existing package.json, merge — keep the existing name and scripts, add Vite's dependencies.

- [ ] **Step 2: Update client/package.json**

```json
{
  "name": "@trock-crm/client",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "start": "npx serve dist -s -l 3000",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.1",
    "recharts": "^2.15.1",
    "clsx": "^2.1.1",
    "tailwind-merge": "^3.0.1",
    "class-variance-authority": "^0.7.1",
    "lucide-react": "^0.469.0",
    "tailwindcss-animate": "^1.0.7"
  },
  "devDependencies": {
    "@types/react": "^19.0.7",
    "@types/react-dom": "^19.0.3",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.7.3",
    "vite": "^6.0.7",
    "serve": "^14.2.4"
  }
}
```

> **Issue #5 fix:** `tailwindcss-animate` is in `dependencies` so it can be ESM-imported (not `require()`'d).

- [ ] **Step 3: Create client/vite.config.ts**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 4: Create client/postcss.config.js**

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 5: Create client/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true,
    "downlevelIteration": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 6: Initialize shadcn/ui (generates tailwind.config.ts, globals.css, utils.ts, components.json)**

> **Issue #6 fix:** We do NOT create `tailwind.config.ts` or `globals.css` manually before this step. `shadcn init` generates both with correct CSS variable mappings for all shadcn component colors.

Run: `cd client && npx shadcn@latest init`

When prompted:
- Style: Default
- Base color: Slate
- CSS variables: Yes
- Path alias: `@/`
- Components alias: `@/components`

This creates:
- `client/tailwind.config.ts` — with all CSS variable color mappings (background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, radius, chart colors)
- `client/src/globals.css` — with `:root` and `.dark` CSS variable definitions
- `client/src/lib/utils.ts` — with `cn()` helper
- `client/components.json` — shadcn config

- [ ] **Step 7: Modify the generated tailwind.config.ts to add brand/sidebar colors**

Edit `client/tailwind.config.ts` to add inside `theme.extend.colors`:

```typescript
// Add these inside the existing theme.extend.colors block that shadcn generated:
brand: {
  purple: "#7C3AED",
  cyan: "#06B6D4",
},
sidebar: {
  bg: "#0F172A",
  hover: "#1E293B",
  active: "#7C3AED22",
},
```

> **Issue #5 fix:** Also change the plugins line from `require("tailwindcss-animate")` to an ESM import:

At the top of `tailwind.config.ts`, add:
```typescript
import tailwindAnimate from "tailwindcss-animate";
```

And change the plugins array to:
```typescript
plugins: [tailwindAnimate],
```

- [ ] **Step 8: Modify the generated globals.css to set primary to brand purple**

Edit `client/src/globals.css` — change only the `--primary` CSS variable in the `:root` block:

```css
--primary: 262 83% 58%;
--ring: 262 83% 58%;
```

This makes shadcn's primary color map to the brand purple. All other shadcn CSS variables remain as generated.

- [ ] **Step 9: Install core shadcn/ui components**

```bash
cd client && npx shadcn@latest add button card input label select dropdown-menu avatar badge separator sheet dialog toast sonner
```

- [ ] **Step 10: Create client/index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>T Rock CRM</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 11: Create client/src/main.tsx**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
```

- [ ] **Step 12: Create client/src/App.tsx**

```tsx
import { Routes, Route, Navigate } from "react-router-dom";
import type { ReactNode } from "react";

function Dashboard() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-brand-purple">T Rock CRM</h1>
        <p className="mt-2 text-muted-foreground">Foundation running. Ready for features.</p>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

> **Issue #7 fix:** Uses `import type { ReactNode } from "react"` instead of `React.ReactNode`. The initial App.tsx is simple and doesn't need ReactNode yet, but the pattern is established for when it's needed in Step 7 (Task 11).

- [ ] **Step 13: Verify frontend runs**

Run: `npm run dev:client`
Expected: Vite dev server starts on port 5173. Browser shows "T Rock CRM" heading with "Foundation running" message.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "chore: scaffold React frontend with Vite, Tailwind, shadcn/ui"
```

---

## Task 3: Shared Schema — Public Tables (Drizzle)

**Files:**
- Create: `shared/src/schema/public/offices.ts`
- Create: `shared/src/schema/public/users.ts`
- Create: `shared/src/schema/public/user-office-access.ts`
- Create: `shared/src/schema/public/pipeline-stage-config.ts`
- Create: `shared/src/schema/public/lost-deal-reasons.ts`
- Create: `shared/src/schema/public/project-type-config.ts`
- Create: `shared/src/schema/public/region-config.ts`
- Create: `shared/src/schema/public/job-queue.ts`
- Create: `shared/src/schema/public/user-graph-tokens.ts`
- Create: `shared/src/schema/public/saved-reports.ts`
- Create: `shared/src/schema/public/procore-sync-state.ts`
- Create: `shared/src/schema/public/procore-webhook-log.ts`
- Create: `shared/src/schema/index.ts`
- Create: `shared/src/types/enums.ts`
- Create: `shared/drizzle.config.ts`
- Create: ALL tenant schema definitions in `shared/src/schema/tenant/`

- [ ] **Step 1: Create shared/src/types/enums.ts**

```typescript
export const USER_ROLES = ["admin", "director", "rep"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DEAL_STAGES = [
  "dd",
  "estimating",
  "bid_sent",
  "in_production",
  "close_out",
  "closed_won",
  "closed_lost",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const CONTACT_CATEGORIES = [
  "client",
  "subcontractor",
  "architect",
  "property_manager",
  "regional_manager",
  "vendor",
  "consultant",
  "influencer",
  "other",
] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

export const ACTIVITY_TYPES = ["call", "note", "meeting", "email", "task_completed"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const CALL_OUTCOMES = [
  "connected",
  "left_voicemail",
  "no_answer",
  "scheduled_meeting",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const FILE_CATEGORIES = [
  "photo",
  "contract",
  "rfp",
  "estimate",
  "change_order",
  "proposal",
  "permit",
  "inspection",
  "correspondence",
  "insurance",
  "warranty",
  "closeout",
  "other",
] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export const TASK_TYPES = [
  "follow_up",
  "stale_deal",
  "inbound_email",
  "approval_request",
  "touchpoint",
  "manual",
  "system",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ["pending", "in_progress", "completed", "dismissed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  "stale_deal",
  "inbound_email",
  "task_assigned",
  "approval_needed",
  "activity_drop",
  "deal_won",
  "deal_lost",
  "stage_change",
  "system",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const PROCORE_ENTITY_TYPES = ["project", "bid", "change_order", "contact"] as const;
export type ProcoreEntityType = (typeof PROCORE_ENTITY_TYPES)[number];

export const SYNC_DIRECTIONS = ["crm_to_procore", "procore_to_crm", "bidirectional"] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export const SYNC_STATUSES = ["synced", "pending", "conflict", "error"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const CHANGE_ORDER_STATUSES = ["pending", "approved", "rejected"] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

export const REPORT_ENTITIES = ["deals", "contacts", "activities", "tasks"] as const;
export type ReportEntity = (typeof REPORT_ENTITIES)[number];

export const GRAPH_TOKEN_STATUSES = ["active", "expired", "revoked", "reauth_needed"] as const;
export type GraphTokenStatus = (typeof GRAPH_TOKEN_STATUSES)[number];

export const JOB_STATUSES = ["pending", "processing", "completed", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const VALIDATION_STATUSES = [
  "pending",
  "valid",
  "invalid",
  "needs_review",
  "approved",
  "rejected",
] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const REPORT_VISIBILITY = ["private", "office", "company"] as const;
export type ReportVisibility = (typeof REPORT_VISIBILITY)[number];

export const DUPLICATE_MATCH_TYPES = [
  "exact_email",
  "fuzzy_name",
  "fuzzy_phone",
  "company_match",
] as const;
export type DuplicateMatchType = (typeof DUPLICATE_MATCH_TYPES)[number];

export const DUPLICATE_STATUSES = ["pending", "merged", "dismissed"] as const;
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];

export const EMAIL_DIRECTIONS = ["inbound", "outbound"] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];

export const AUDIT_ACTIONS = ["insert", "update", "delete"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
```

> **Issue #22 fix:** Added `PROCORE_ENTITY_TYPES` and `REPORT_ENTITIES` as proper enum arrays (used as pgEnum in schema definitions) instead of plain varchar columns.

- [ ] **Step 2: Create shared/src/schema/public/offices.ts**

```typescript
import { pgTable, uuid, varchar, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

export const offices = pgTable("offices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  address: text("address"),
  phone: varchar("phone", { length: 20 }),
  isActive: boolean("is_active").default(true).notNull(),
  settings: jsonb("settings").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 3: Create shared/src/schema/public/users.ts**

```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { offices } from "./offices.js";
import { USER_ROLES } from "../../types/enums.js";

export const userRoleEnum = pgEnum("user_role", USER_ROLES);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  azureAdId: varchar("azure_ad_id", { length: 255 }).unique(),
  avatarUrl: text("avatar_url"),
  role: userRoleEnum("role").notNull(),
  officeId: uuid("office_id")
    .references(() => offices.id)
    .notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  notificationPrefs: jsonb("notification_prefs").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 4: Create shared/src/schema/public/user-office-access.ts**

```typescript
import { pgTable, uuid, unique } from "drizzle-orm/pg-core";
import { users, userRoleEnum } from "./users.js";
import { offices } from "./offices.js";

export const userOfficeAccess = pgTable(
  "user_office_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    officeId: uuid("office_id")
      .references(() => offices.id)
      .notNull(),
    roleOverride: userRoleEnum("role_override"),
  },
  (table) => [unique().on(table.userId, table.officeId)]
);
```

- [ ] **Step 5: Create shared/src/schema/public/pipeline-stage-config.ts**

```typescript
import { pgTable, uuid, varchar, integer, boolean, jsonb } from "drizzle-orm/pg-core";

export const pipelineStageConfig = pgTable("pipeline_stage_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  displayOrder: integer("display_order").notNull(),
  isActivePipeline: boolean("is_active_pipeline").default(true).notNull(),
  isTerminal: boolean("is_terminal").default(false).notNull(),
  requiredFields: jsonb("required_fields").default([]).notNull(),
  requiredDocuments: jsonb("required_documents").default([]).notNull(),
  requiredApprovals: jsonb("required_approvals").default([]).notNull(),
  staleThresholdDays: integer("stale_threshold_days"),
  procoreStageMapping: varchar("procore_stage_mapping", { length: 100 }),
  color: varchar("color", { length: 7 }),
});
```

- [ ] **Step 6: Create shared/src/schema/public/lost-deal-reasons.ts**

```typescript
import { pgTable, uuid, varchar, boolean, integer } from "drizzle-orm/pg-core";

export const lostDealReasons = pgTable("lost_deal_reasons", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: varchar("label", { length: 255 }).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  displayOrder: integer("display_order").notNull(),
});
```

- [ ] **Step 7: Create shared/src/schema/public/project-type-config.ts**

```typescript
import { pgTable, uuid, varchar, integer, boolean } from "drizzle-orm/pg-core";

export const projectTypeConfig = pgTable("project_type_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  parentId: uuid("parent_id").references((): any => projectTypeConfig.id),
  displayOrder: integer("display_order").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});
```

- [ ] **Step 8: Create shared/src/schema/public/region-config.ts**

```typescript
import { pgTable, uuid, varchar, integer, boolean, text } from "drizzle-orm/pg-core";

export const regionConfig = pgTable("region_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  states: text("states").array().notNull(),
  displayOrder: integer("display_order").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});
```

- [ ] **Step 9: Create shared/src/schema/public/job-queue.ts**

```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  jsonb,
  integer,
  text,
  timestamp,
  bigserial,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offices } from "./offices.js";
import { JOB_STATUSES } from "../../types/enums.js";

export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);

export const jobQueue = pgTable(
  "job_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobType: varchar("job_type", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull(),
    officeId: uuid("office_id").references(() => offices.id),
    status: jobStatusEnum("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    lastError: text("last_error"),
    startedProcessingAt: timestamp("started_processing_at", { withTimezone: true }),
    runAfter: timestamp("run_after", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("job_queue_pending_idx")
      .on(table.status, table.runAfter)
      .where(sql`status = 'pending'`),
  ]
);
```

> **Issue #21 fix:** Added `startedProcessingAt` column. Stale job recovery checks this timestamp instead of `created_at`.

- [ ] **Step 10: Create shared/src/schema/public/user-graph-tokens.ts**

```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { GRAPH_TOKEN_STATUSES } from "../../types/enums.js";

export const graphTokenStatusEnum = pgEnum("graph_token_status", GRAPH_TOKEN_STATUSES);

export const userGraphTokens = pgTable("user_graph_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id)
    .unique()
    .notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes").array().notNull(),
  subscriptionId: varchar("subscription_id", { length: 255 }),
  subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
  lastDeltaLink: text("last_delta_link"),
  status: graphTokenStatusEnum("status").default("active").notNull(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 11: Create shared/src/schema/public/saved-reports.ts**

```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  jsonb,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { offices } from "./offices.js";
import { REPORT_VISIBILITY, REPORT_ENTITIES } from "../../types/enums.js";

export const reportVisibilityEnum = pgEnum("report_visibility", REPORT_VISIBILITY);
export const reportEntityEnum = pgEnum("report_entity", REPORT_ENTITIES);

export const savedReports = pgTable("saved_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  entity: reportEntityEnum("entity").notNull(),
  config: jsonb("config").notNull(),
  isLocked: boolean("is_locked").default(false).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  officeId: uuid("office_id").references(() => offices.id),
  visibility: reportVisibilityEnum("visibility").default("private").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

> **Issue #22 fix:** `entity` column uses `reportEntityEnum` (pgEnum) instead of plain varchar.

- [ ] **Step 12: Create shared/src/schema/public/procore-sync-state.ts and procore-webhook-log.ts**

`shared/src/schema/public/procore-sync-state.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  bigint,
  jsonb,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offices } from "./offices.js";
import { PROCORE_ENTITY_TYPES, SYNC_DIRECTIONS, SYNC_STATUSES } from "../../types/enums.js";

export const procoreEntityTypeEnum = pgEnum("procore_entity_type", PROCORE_ENTITY_TYPES);
export const syncDirectionEnum = pgEnum("sync_direction", SYNC_DIRECTIONS);
export const syncStatusEnum = pgEnum("sync_status", SYNC_STATUSES);

export const procoreSyncState = pgTable(
  "procore_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: procoreEntityTypeEnum("entity_type").notNull(),
    procoreId: bigint("procore_id", { mode: "number" }).notNull(),
    crmEntityType: varchar("crm_entity_type", { length: 50 }).notNull(),
    crmEntityId: uuid("crm_entity_id").notNull(),
    officeId: uuid("office_id")
      .references(() => offices.id)
      .notNull(),
    syncDirection: syncDirectionEnum("sync_direction").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastProcoreUpdatedAt: timestamp("last_procore_updated_at", { withTimezone: true }),
    lastCrmUpdatedAt: timestamp("last_crm_updated_at", { withTimezone: true }),
    syncStatus: syncStatusEnum("sync_status").default("synced").notNull(),
    conflictData: jsonb("conflict_data"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.entityType, table.procoreId, table.officeId),
    index("procore_sync_out_of_sync_idx")
      .on(table.syncStatus)
      .where(sql`sync_status != 'synced'`),
  ]
);
```

> **Issue #22 fix:** `entity_type` uses `procoreEntityTypeEnum` (pgEnum) instead of varchar.

`shared/src/schema/public/procore-webhook-log.ts`:
```typescript
import {
  pgTable,
  bigserial,
  varchar,
  bigint,
  jsonb,
  boolean,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const procoreWebhookLog = pgTable(
  "procore_webhook_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    resourceId: bigint("resource_id", { mode: "number" }).notNull(),
    payload: jsonb("payload").notNull(),
    processed: boolean("processed").default(false).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("webhook_unprocessed_idx").on(table.processed, table.receivedAt)]
);
```

- [ ] **Step 13: Create ALL tenant schema definitions**

> **Issue #14 fix:** ALL tenant table schemas must be defined in `shared/src/schema/tenant/` so Drizzle can resolve types when querying tenant tables. Without these, `drizzle(client, { schema })` cannot provide typed queries for tenant data.

`shared/src/schema/tenant/deals.ts`:
```typescript
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  numeric,
  bigint,
  integer,
  date,
  timestamp,
} from "drizzle-orm/pg-core";

// Note: These reference public schema tables by UUID. Drizzle cross-schema references
// are defined here for TypeScript typing. The actual FK constraints are in the SQL migration
// because Drizzle doesn't natively handle cross-schema references.

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealNumber: varchar("deal_number", { length: 50 }).unique().notNull(),
  name: varchar("name", { length: 500 }).notNull(),
  stageId: uuid("stage_id").notNull(),
  assignedRepId: uuid("assigned_rep_id").notNull(),
  primaryContactId: uuid("primary_contact_id"),
  ddEstimate: numeric("dd_estimate", { precision: 14, scale: 2 }),
  bidEstimate: numeric("bid_estimate", { precision: 14, scale: 2 }),
  awardedAmount: numeric("awarded_amount", { precision: 14, scale: 2 }),
  changeOrderTotal: numeric("change_order_total", { precision: 14, scale: 2 }).default("0"),
  description: text("description"),
  propertyAddress: text("property_address"),
  propertyCity: varchar("property_city", { length: 255 }),
  propertyState: varchar("property_state", { length: 2 }),
  propertyZip: varchar("property_zip", { length: 10 }),
  projectTypeId: uuid("project_type_id"),
  regionId: uuid("region_id"),
  source: varchar("source", { length: 100 }),
  winProbability: integer("win_probability"),
  procoreProjectId: bigint("procore_project_id", { mode: "number" }),
  procoreBidId: bigint("procore_bid_id", { mode: "number" }),
  procoreLastSyncedAt: timestamp("procore_last_synced_at", { withTimezone: true }),
  lostReasonId: uuid("lost_reason_id"),
  lostNotes: text("lost_notes"),
  lostCompetitor: varchar("lost_competitor", { length: 255 }),
  lostAt: timestamp("lost_at", { withTimezone: true }),
  expectedCloseDate: date("expected_close_date"),
  actualCloseDate: date("actual_close_date"),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).defaultNow().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  hubspotDealId: varchar("hubspot_deal_id", { length: 50 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

`shared/src/schema/tenant/deal-stage-history.ts`:
```typescript
import { pgTable, uuid, boolean, text, interval, timestamp } from "drizzle-orm/pg-core";

export const dealStageHistory = pgTable("deal_stage_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull(),
  fromStageId: uuid("from_stage_id"),
  toStageId: uuid("to_stage_id").notNull(),
  changedBy: uuid("changed_by").notNull(),
  isBackwardMove: boolean("is_backward_move").default(false).notNull(),
  isDirectorOverride: boolean("is_director_override").default(false).notNull(),
  overrideReason: text("override_reason"),
  durationInPreviousStage: interval("duration_in_previous_stage"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

`shared/src/schema/tenant/change-orders.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  integer,
  varchar,
  numeric,
  bigint,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { CHANGE_ORDER_STATUSES } from "../../types/enums.js";

export const changeOrderStatusEnum = pgEnum("change_order_status", CHANGE_ORDER_STATUSES);

export const changeOrders = pgTable(
  "change_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    coNumber: integer("co_number").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    status: changeOrderStatusEnum("status").default("pending").notNull(),
    procoreCoId: bigint("procore_co_id", { mode: "number" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.dealId, table.coNumber)]
);
```

`shared/src/schema/tenant/deal-approvals.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { APPROVAL_STATUSES } from "../../types/enums.js";
import { userRoleEnum } from "../public/users.js";

export const approvalStatusEnum = pgEnum("approval_status", APPROVAL_STATUSES);

export const dealApprovals = pgTable(
  "deal_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    targetStageId: uuid("target_stage_id").notNull(),
    requiredRole: userRoleEnum("required_role").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    approvedBy: uuid("approved_by"),
    status: approvalStatusEnum("status").default("pending").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.dealId, table.targetStageId, table.requiredRole)]
);
```

`shared/src/schema/tenant/contacts.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { CONTACT_CATEGORIES } from "../../types/enums.js";

export const contactCategoryEnum = pgEnum("contact_category", CONTACT_CATEGORIES);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firstName: varchar("first_name", { length: 255 }).notNull(),
    lastName: varchar("last_name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 20 }),
    mobile: varchar("mobile", { length: 20 }),
    companyName: varchar("company_name", { length: 500 }),
    jobTitle: varchar("job_title", { length: 255 }),
    category: contactCategoryEnum("category").notNull(),
    address: text("address"),
    city: varchar("city", { length: 255 }),
    state: varchar("state", { length: 2 }),
    zip: varchar("zip", { length: 10 }),
    notes: text("notes"),
    touchpointCount: integer("touchpoint_count").default(0).notNull(),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    firstOutreachCompleted: boolean("first_outreach_completed").default(false).notNull(),
    procoreContactId: bigint("procore_contact_id", { mode: "number" }),
    hubspotContactId: varchar("hubspot_contact_id", { length: 50 }),
    normalizedPhone: varchar("normalized_phone", { length: 20 }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("contacts_name_company_idx").on(table.companyName),
  ]
);
```

`shared/src/schema/tenant/contact-deal-associations.ts`:
```typescript
import { pgTable, uuid, varchar, boolean, timestamp, unique } from "drizzle-orm/pg-core";

export const contactDealAssociations = pgTable(
  "contact_deal_associations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull(),
    dealId: uuid("deal_id").notNull(),
    role: varchar("role", { length: 100 }),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.contactId, table.dealId)]
);
```

`shared/src/schema/tenant/duplicate-queue.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  numeric,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { DUPLICATE_MATCH_TYPES, DUPLICATE_STATUSES } from "../../types/enums.js";

export const duplicateMatchTypeEnum = pgEnum("duplicate_match_type", DUPLICATE_MATCH_TYPES);
export const duplicateStatusEnum = pgEnum("duplicate_status", DUPLICATE_STATUSES);

export const duplicateQueue = pgTable(
  "duplicate_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactAId: uuid("contact_a_id").notNull(),
    contactBId: uuid("contact_b_id").notNull(),
    matchType: duplicateMatchTypeEnum("match_type").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 3, scale: 2 }),
    status: duplicateStatusEnum("status").default("pending").notNull(),
    resolvedBy: uuid("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.contactAId, table.contactBId)]
);
```

`shared/src/schema/tenant/emails.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { EMAIL_DIRECTIONS } from "../../types/enums.js";

export const emailDirectionEnum = pgEnum("email_direction", EMAIL_DIRECTIONS);

export const emails = pgTable("emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphMessageId: varchar("graph_message_id", { length: 500 }).unique().notNull(),
  graphConversationId: varchar("graph_conversation_id", { length: 500 }),
  direction: emailDirectionEnum("direction").notNull(),
  fromAddress: varchar("from_address", { length: 255 }).notNull(),
  toAddresses: text("to_addresses").array().notNull(),
  ccAddresses: text("cc_addresses").array(),
  subject: varchar("subject", { length: 1000 }),
  bodyPreview: varchar("body_preview", { length: 500 }),
  bodyHtml: text("body_html"),
  hasAttachments: boolean("has_attachments").default(false).notNull(),
  contactId: uuid("contact_id"),
  dealId: uuid("deal_id"),
  userId: uuid("user_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
});
```

`shared/src/schema/tenant/activities.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { ACTIVITY_TYPES } from "../../types/enums.js";

export const activityTypeEnum = pgEnum("activity_type", ACTIVITY_TYPES);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: activityTypeEnum("type").notNull(),
    userId: uuid("user_id").notNull(),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id"),
    emailId: uuid("email_id"),
    subject: varchar("subject", { length: 500 }),
    body: text("body"),
    outcome: varchar("outcome", { length: 100 }),
    durationMinutes: integer("duration_minutes"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("activities_user_idx").on(table.userId, table.occurredAt),
    index("activities_deal_idx").on(table.dealId, table.occurredAt),
    index("activities_contact_idx").on(table.contactId, table.occurredAt),
  ]
);
```

`shared/src/schema/tenant/files.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  bigint,
  integer,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { FILE_CATEGORIES } from "../../types/enums.js";

export const fileCategoryEnum = pgEnum("file_category", FILE_CATEGORIES);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    category: fileCategoryEnum("category").notNull(),
    subcategory: varchar("subcategory", { length: 100 }),
    folderPath: varchar("folder_path", { length: 1000 }),
    tags: text("tags").array().default([]).notNull(),
    displayName: varchar("display_name", { length: 500 }).notNull(),
    systemFilename: varchar("system_filename", { length: 500 }).notNull(),
    originalFilename: varchar("original_filename", { length: 500 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    fileExtension: varchar("file_extension", { length: 20 }).notNull(),
    r2Key: varchar("r2_key", { length: 1000 }).unique().notNull(),
    r2Bucket: varchar("r2_bucket", { length: 100 }).notNull(),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id"),
    procoreProjectId: bigint("procore_project_id", { mode: "number" }),
    changeOrderId: uuid("change_order_id"),
    description: text("description"),
    notes: text("notes"),
    version: integer("version").default(1).notNull(),
    parentFileId: uuid("parent_file_id"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    geoLat: numeric("geo_lat", { precision: 10, scale: 7 }),
    geoLng: numeric("geo_lng", { precision: 10, scale: 7 }),
    uploadedBy: uuid("uploaded_by").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("files_deal_idx").on(table.dealId, table.category, table.createdAt),
    index("files_folder_idx").on(table.folderPath, table.displayName),
  ]
);
```

`shared/src/schema/tenant/tasks.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  date,
  time,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "../../types/enums.js";

export const taskTypeEnum = pgEnum("task_type", TASK_TYPES);
export const taskPriorityEnum = pgEnum("task_priority", TASK_PRIORITIES);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUSES);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    type: taskTypeEnum("type").notNull(),
    priority: taskPriorityEnum("priority").default("normal").notNull(),
    status: taskStatusEnum("status").default("pending").notNull(),
    assignedTo: uuid("assigned_to").notNull(),
    createdBy: uuid("created_by"),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id"),
    emailId: uuid("email_id"),
    dueDate: date("due_date"),
    dueTime: time("due_time"),
    remindAt: timestamp("remind_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    isOverdue: boolean("is_overdue").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("tasks_assigned_status_idx").on(table.assignedTo, table.status, table.dueDate),
    index("tasks_priority_idx").on(table.assignedTo, table.status, table.priority),
  ]
);
```

`shared/src/schema/tenant/notifications.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { NOTIFICATION_TYPES } from "../../types/enums.js";

export const notificationTypeEnum = pgEnum("notification_type", NOTIFICATION_TYPES);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    type: notificationTypeEnum("type").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    body: text("body"),
    link: varchar("link", { length: 1000 }),
    isRead: boolean("is_read").default(false).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("notifications_user_unread_idx").on(table.userId, table.isRead, table.createdAt),
  ]
);
```

`shared/src/schema/tenant/audit-log.ts`:
```typescript
import {
  pgTable,
  pgEnum,
  bigserial,
  uuid,
  varchar,
  jsonb,
  inet,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { AUDIT_ACTIONS } from "../../types/enums.js";

export const auditActionEnum = pgEnum("audit_action", AUDIT_ACTIONS);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tableName: varchar("table_name", { length: 100 }).notNull(),
    recordId: uuid("record_id").notNull(),
    action: auditActionEnum("action").notNull(),
    changedBy: uuid("changed_by"),
    changes: jsonb("changes"),
    fullRow: jsonb("full_row"),
    ipAddress: inet("ip_address"),
    userAgent: varchar("user_agent", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_record_idx").on(table.tableName, table.recordId, table.createdAt),
    index("audit_user_idx").on(table.changedBy, table.createdAt),
    index("audit_time_idx").on(table.createdAt),
  ]
);
```

- [ ] **Step 14: Create shared/src/schema/index.ts**

```typescript
// Public schema tables
export { offices } from "./public/offices.js";
export { users, userRoleEnum } from "./public/users.js";
export { userOfficeAccess } from "./public/user-office-access.js";
export { pipelineStageConfig } from "./public/pipeline-stage-config.js";
export { lostDealReasons } from "./public/lost-deal-reasons.js";
export { projectTypeConfig } from "./public/project-type-config.js";
export { regionConfig } from "./public/region-config.js";
export { savedReports, reportVisibilityEnum, reportEntityEnum } from "./public/saved-reports.js";
export { procoreSyncState, procoreEntityTypeEnum, syncDirectionEnum, syncStatusEnum } from "./public/procore-sync-state.js";
export { procoreWebhookLog } from "./public/procore-webhook-log.js";
export { userGraphTokens, graphTokenStatusEnum } from "./public/user-graph-tokens.js";
export { jobQueue, jobStatusEnum } from "./public/job-queue.js";

// Tenant schema tables (used for Drizzle type resolution when querying via tenantDb)
export { deals } from "./tenant/deals.js";
export { dealStageHistory } from "./tenant/deal-stage-history.js";
export { changeOrders, changeOrderStatusEnum } from "./tenant/change-orders.js";
export { dealApprovals, approvalStatusEnum } from "./tenant/deal-approvals.js";
export { contacts, contactCategoryEnum } from "./tenant/contacts.js";
export { contactDealAssociations } from "./tenant/contact-deal-associations.js";
export { duplicateQueue, duplicateMatchTypeEnum, duplicateStatusEnum } from "./tenant/duplicate-queue.js";
export { emails, emailDirectionEnum } from "./tenant/emails.js";
export { activities, activityTypeEnum } from "./tenant/activities.js";
export { files, fileCategoryEnum } from "./tenant/files.js";
export { tasks, taskTypeEnum, taskPriorityEnum, taskStatusEnum } from "./tenant/tasks.js";
export { notifications, notificationTypeEnum } from "./tenant/notifications.js";
export { auditLog, auditActionEnum } from "./tenant/audit-log.js";
```

> **Issue #14 fix:** Both public AND tenant schemas are exported. This is required for `drizzle(client, { schema })` to resolve tenant table types when running queries through `req.tenantDb`.

- [ ] **Step 15: Create shared/drizzle.config.ts**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "../migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 16: Verify schema compiles**

Run: `npx tsc --noEmit --project shared/tsconfig.json`
Expected: No errors.

- [ ] **Step 17: Commit**

```bash
git add -A
git commit -m "feat: add Drizzle schema definitions for all public and tenant tables"
```

---

## Task 4: Initial SQL Migration — Public Schema + Default Office Schema + Triggers + Seed Data

**Files:**
- Create: `migrations/0001_initial.sql`

This is a hand-written SQL migration (not Drizzle-generated) because it needs to:
1. Create custom enums with `DO $$ IF NOT EXISTS` blocks (PG doesn't support `CREATE TYPE IF NOT EXISTS`)
2. Create the public schema tables
3. Create the default `office_dallas` schema with all tenant tables
4. Install PG triggers
5. Seed pipeline stages, project types, regions, and lost deal reasons

- [ ] **Step 1: Write the migration SQL**

This file is large. Create `migrations/0001_initial.sql` with the complete SQL. Key sections:

**Section 1 — Enums:**
```sql
-- Enums (idempotent)
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'director', 'rep');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'dead');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE graph_token_status AS ENUM ('active', 'expired', 'revoked', 'reauth_needed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sync_direction AS ENUM ('crm_to_procore', 'procore_to_crm', 'bidirectional');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sync_status AS ENUM ('synced', 'pending', 'conflict', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_visibility AS ENUM ('private', 'office', 'company');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE procore_entity_type AS ENUM ('project', 'bid', 'change_order', 'contact');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_entity AS ENUM ('deals', 'contacts', 'activities', 'tasks');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE change_order_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE contact_category AS ENUM ('client', 'subcontractor', 'architect', 'property_manager', 'regional_manager', 'vendor', 'consultant', 'influencer', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE activity_type AS ENUM ('call', 'note', 'meeting', 'email', 'task_completed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE file_category AS ENUM ('photo', 'contract', 'rfp', 'estimate', 'change_order', 'proposal', 'permit', 'inspection', 'correspondence', 'insurance', 'warranty', 'closeout', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE task_type AS ENUM ('follow_up', 'stale_deal', 'inbound_email', 'approval_request', 'touchpoint', 'manual', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE task_priority AS ENUM ('urgent', 'high', 'normal', 'low');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('pending', 'in_progress', 'completed', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM ('stale_deal', 'inbound_email', 'task_assigned', 'approval_needed', 'activity_drop', 'deal_won', 'deal_lost', 'stage_change', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE email_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE duplicate_match_type AS ENUM ('exact_email', 'fuzzy_name', 'fuzzy_phone', 'company_match');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE duplicate_status AS ENUM ('pending', 'merged', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM ('insert', 'update', 'delete');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

**Section 2 — Public tables** (offices, users, user_office_access, pipeline_stage_config, lost_deal_reasons, project_type_config, region_config, saved_reports, procore_sync_state, procore_webhook_log, user_graph_tokens, job_queue). Note: `job_queue` must include the `started_processing_at TIMESTAMPTZ` column.

**Section 3 — Audit trigger function** (reusable across all schemas):
```sql
CREATE OR REPLACE FUNCTION audit_trigger_func()
RETURNS TRIGGER AS $$
DECLARE
  changed_fields JSONB := '{}';
  col_name TEXT;
  old_val TEXT;
  new_val TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (table_name, record_id, action, changed_by, full_row, created_at)
    VALUES (TG_TABLE_NAME, NEW.id, 'insert',
            NULLIF(current_setting('app.current_user_id', true), '')::UUID,
            to_jsonb(NEW), NOW());
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR col_name IN SELECT column_name FROM information_schema.columns
      WHERE table_schema = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME
    LOOP
      EXECUTE format('SELECT ($1).%I::TEXT, ($2).%I::TEXT', col_name, col_name)
        INTO old_val, new_val USING OLD, NEW;
      IF old_val IS DISTINCT FROM new_val THEN
        changed_fields := changed_fields || jsonb_build_object(
          col_name, jsonb_build_object('old', old_val, 'new', new_val)
        );
      END IF;
    END LOOP;
    IF changed_fields != '{}' THEN
      INSERT INTO audit_log (table_name, record_id, action, changed_by, changes, created_at)
      VALUES (TG_TABLE_NAME, NEW.id, 'update',
              NULLIF(current_setting('app.current_user_id', true), '')::UUID,
              changed_fields, NOW());
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (table_name, record_id, action, changed_by, full_row, created_at)
    VALUES (TG_TABLE_NAME, OLD.id, 'delete',
            NULLIF(current_setting('app.current_user_id', true), '')::UUID,
            to_jsonb(OLD), NOW());
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
```

**Section 4 — updated_at trigger function:**
```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Section 5 — Do NOT create a single `provision_office_schema()` PG function.** Instead, the tenant table DDL SQL is embedded in the migration runner (see Task 4 Step 2). This ensures new offices always get the latest schema version by running ALL migration files against the new schema.

> **Issue #19 fix:** A static PG function would go stale as new migrations add columns/tables. The migration runner approach ensures every new office gets the complete, current schema.

**Section 6 — Create default `office_dallas` schema.** The tenant DDL MUST be wrapped in marker comments so the provisioning runner can extract it for new offices:

```sql
-- TENANT_SCHEMA_START
-- Everything between these markers is re-run for each new office schema.
-- The placeholder 'office_dallas' is replaced with the actual schema name.

CREATE SCHEMA IF NOT EXISTS office_dallas;
SET search_path = 'office_dallas', 'public';

-- [ALL tenant tables go here: deals, deal_stage_history, change_orders,
-- deal_approvals, contacts, contact_deal_associations, duplicate_queue,
-- emails, activities, files, tasks, notifications, audit_log]
-- [ALL tenant triggers go here: audit, updated_at, change_order_total,
-- stage_history, stage_entered_at, touchpoint, normalized_phone]

RESET search_path;
-- TENANT_SCHEMA_END
```

The tenant DDL includes ALL tables from section 4.2 of the design spec (deals, deal_stage_history, change_orders, deal_approvals, contacts, contact_deal_associations, duplicate_queue, emails, activities, files, tasks, notifications, audit_log) plus all triggers. Use `office_dallas` as the schema name — the provisioning runner replaces it with the target schema name when creating new offices.

**Section 7 — Seed data:**
```sql
-- Seed pipeline stages
INSERT INTO pipeline_stage_config (name, slug, display_order, is_active_pipeline, is_terminal, stale_threshold_days, color) VALUES
  ('Due Diligence', 'dd', 1, false, false, 90, '#6B7280'),
  ('Estimating', 'estimating', 2, true, false, 60, '#F59E0B'),
  ('Bid Sent', 'bid_sent', 3, true, false, 30, '#3B82F6'),
  ('In Production', 'in_production', 4, true, false, NULL, '#8B5CF6'),
  ('Close Out', 'close_out', 5, true, false, 30, '#06B6D4'),
  ('Closed Won', 'closed_won', 6, true, true, NULL, '#22C55E'),
  ('Closed Lost', 'closed_lost', 7, true, true, NULL, '#EF4444')
ON CONFLICT (slug) DO NOTHING;

-- Seed project types
INSERT INTO project_type_config (name, slug, parent_id, display_order) VALUES
  ('Multifamily', 'multifamily', NULL, 1),
  ('Commercial', 'commercial', NULL, 2),
  ('Service', 'service', NULL, 3),
  ('Restoration', 'restoration', NULL, 4)
ON CONFLICT (slug) DO NOTHING;

-- Seed sub-types (requires parent IDs)
INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'Traditional Multifamily', 'traditional_multifamily', id, 1
FROM project_type_config WHERE slug = 'multifamily'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'Student Housing', 'student_housing', id, 2
FROM project_type_config WHERE slug = 'multifamily'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'Senior Living', 'senior_living', id, 3
FROM project_type_config WHERE slug = 'multifamily'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'New Construction', 'new_construction', id, 1
FROM project_type_config WHERE slug = 'commercial'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'Land Development', 'land_development', id, 2
FROM project_type_config WHERE slug = 'commercial'
ON CONFLICT (slug) DO NOTHING;

-- Seed regions
INSERT INTO region_config (name, slug, states, display_order) VALUES
  ('Texas', 'texas', ARRAY['TX'], 1),
  ('East Coast', 'east_coast', ARRAY['NY', 'NJ', 'CT', 'PA', 'MA', 'VA', 'MD', 'DC'], 2),
  ('Southeast', 'southeast', ARRAY['FL', 'GA', 'NC', 'SC', 'TN', 'AL'], 3)
ON CONFLICT (slug) DO NOTHING;

-- Seed lost deal reasons
INSERT INTO lost_deal_reasons (label, display_order) VALUES
  ('Price', 1),
  ('Timing', 2),
  ('Went with competitor', 3),
  ('Scope changed', 4),
  ('Project cancelled', 5),
  ('No response', 6),
  ('Relationship', 7),
  ('Other', 8)
ON CONFLICT DO NOTHING;

-- Seed default office
INSERT INTO offices (name, slug, address) VALUES
  ('Dallas', 'dallas', 'Dallas, TX')
ON CONFLICT (slug) DO NOTHING;

-- Seed dev users (only used in dev mode)
INSERT INTO users (email, display_name, role, office_id)
SELECT 'admin@trock.dev', 'Admin User', 'admin', id FROM offices WHERE slug = 'dallas'
ON CONFLICT (email) DO NOTHING;

INSERT INTO users (email, display_name, role, office_id)
SELECT 'director@trock.dev', 'James Director', 'director', id FROM offices WHERE slug = 'dallas'
ON CONFLICT (email) DO NOTHING;

INSERT INTO users (email, display_name, role, office_id)
SELECT 'rep@trock.dev', 'Caleb Rep', 'rep', id FROM offices WHERE slug = 'dallas'
ON CONFLICT (email) DO NOTHING;
```

The complete SQL file will be ~600 lines. Write the full file with all sections.

- [ ] **Step 2: Create migration runner**

Create `server/src/migrations/runner.ts`:

> **Issue #19 fix:** The runner reads ALL migration files from the `migrations/` directory and runs them in order. When provisioning a new office, it runs the tenant-specific parts of each migration against the new schema. This replaces the static `provision_office_schema()` PG function.

```typescript
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");

async function runMigrations() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Read migration files sorted alphabetically
    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of migrationFiles) {
      // Check if already run
      const { rows } = await client.query(
        "SELECT id FROM public._migrations WHERE name = $1",
        [file]
      );
      if (rows.length > 0) {
        console.log(`Skipping ${file} (already executed)`);
        continue;
      }

      console.log(`Running ${file}...`);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);

      await client.query(
        "INSERT INTO public._migrations (name) VALUES ($1)",
        [file]
      );
      console.log(`Completed ${file}`);
    }

    console.log("All migrations complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();
```

- [ ] **Step 3: Run migration against local PostgreSQL**

Run: `npm run db:migrate`
Expected: All tables created, seed data inserted, `office_dallas` schema exists with all tenant tables.

- [ ] **Step 4: Verify with psql**

```bash
psql $DATABASE_URL -c "\dt public.*"
psql $DATABASE_URL -c "\dt office_dallas.*"
psql $DATABASE_URL -c "SELECT name, slug, display_order FROM pipeline_stage_config ORDER BY display_order;"
```

Expected: Public tables listed, office_dallas tables listed, 7 pipeline stages shown.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add initial SQL migration with public schema, office_dallas tenant schema, triggers, and seed data"
```

---

## Task 5: Express Server + Database Connection + Core Middleware

**Files:**
- Create: `server/src/db.ts`
- Create: `server/src/app.ts`
- Create: `server/src/index.ts`
- Create: `server/src/middleware/error-handler.ts`
- Create: `server/src/middleware/rate-limit.ts`

- [ ] **Step 1: Create server/src/db.ts**

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@trock-crm/shared/schema";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err);
});

export const db = drizzle(pool, { schema });
export { pool };
```

- [ ] **Step 2: Create server/src/middleware/error-handler.ts**

```typescript
import type { Request, Response, NextFunction } from "express";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error(`[ERROR] ${err.message}`, err.stack);

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { message: err.message, code: err.code },
    });
    return;
  }

  res.status(500).json({
    error: { message: "Internal server error" },
  });
}
```

- [ ] **Step 3: Create server/src/middleware/rate-limit.ts**

```typescript
import rateLimit from "express-rate-limit";

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests, please try again later" } },
});

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many auth attempts, please try again later" } },
});
```

- [ ] **Step 4: Create server/src/app.ts**

```typescript
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { errorHandler } from "./middleware/error-handler.js";
import { apiLimiter } from "./middleware/rate-limit.js";
import { authRoutes } from "./modules/auth/routes.js";
import { officeRoutes } from "./modules/office/routes.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";

export function createApp() {
  const app = express();

  // Core middleware
  app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  }));
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use("/api", apiLimiter);

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Public routes (no auth required for login endpoints)
  app.use("/api/auth", authRoutes);

  // Admin routes (auth required, no tenant context)
  app.use("/api/offices", officeRoutes);

  // SSE notification endpoint (auth required, no tenant context needed for keepalive)
  app.use("/api/notifications", notificationRoutes);

  // Tenant-scoped routes — auth + tenant middleware applied
  // All feature routes (deals, contacts, tasks, etc.) go through this chain
  const tenantRouter = Router();
  
  // Foundation test route — proves tenant middleware works end-to-end
  tenantRouter.get("/tenant-check", async (req, res) => {
    const result = await req.tenantClient!.query("SELECT current_setting('search_path') as path, current_setting('app.current_user_id', true) as uid");
    await req.commitTransaction!();
    res.json({
      officeSlug: req.officeSlug,
      searchPath: result.rows[0].path,
      auditUserId: result.rows[0].uid,
    });
  });

  app.use("/api", authMiddleware, tenantMiddleware, tenantRouter);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
```

> **Issue #11 fix:** tenantMiddleware is wired onto `/api` with a test route at `GET /api/tenant-check` that verifies search_path and audit user are set correctly. All future feature routes (deals, contacts, etc.) will be added to `tenantRouter`.

- [ ] **Step 5: Create server/src/index.ts**

```typescript
import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`[API] T Rock CRM server running on port ${PORT}`);
});
```

- [ ] **Step 6: Verify server starts**

Run: `npm run dev:server`
Expected: Console shows `[API] T Rock CRM server running on port 3001`

Test: `curl http://localhost:3001/api/health`
Expected: `{"status":"ok","timestamp":"..."}`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Express server with DB connection, error handler, rate limiting, health check"
```

---

## Task 6: Auth Middleware — JWT + Dev-Mode User Picker

**Files:**
- Create: `server/src/middleware/auth.ts`
- Create: `server/src/modules/auth/service.ts`
- Create: `server/src/modules/auth/routes.ts`
- Create: `shared/src/types/auth.ts`
- Create: `shared/src/types/events.ts`
- Create: `shared/src/types/index.ts`
- Test: `server/tests/modules/auth.test.ts`

- [ ] **Step 1: Create shared/src/types/auth.ts**

```typescript
import type { UserRole } from "./enums.js";

export interface JwtClaims {
  userId: string;
  email: string;
  officeId: string;
  role: UserRole;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  officeId: string;
  activeOfficeId: string; // May differ from officeId if user switched offices
}
```

- [ ] **Step 2: Create shared/src/types/events.ts**

```typescript
export const DOMAIN_EVENTS = {
  DEAL_STAGE_CHANGED: "deal.stage.changed",
  DEAL_WON: "deal.won",
  DEAL_LOST: "deal.lost",
  CONTACT_CREATED: "contact.created",
  EMAIL_RECEIVED: "email.received",
  EMAIL_SENT: "email.sent",
  FILE_UPLOADED: "file.uploaded",
  TASK_COMPLETED: "task.completed",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_RESOLVED: "approval.resolved",
} as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export interface DomainEvent<T = unknown> {
  name: DomainEventName;
  payload: T;
  officeId: string;
  userId: string;
  timestamp: Date;
}
```

- [ ] **Step 3: Create shared/src/types/index.ts**

```typescript
export * from "./auth.js";
export * from "./enums.js";
export * from "./events.js";
```

- [ ] **Step 4: Create server/src/modules/auth/service.ts**

```typescript
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { users, userOfficeAccess } from "@trock-crm/shared/schema";
import type { JwtClaims } from "@trock-crm/shared/types";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production" && !secret) {
    throw new Error("JWT_SECRET must be set in production");
  }
  return secret || "dev-secret-change-in-production";
}

const JWT_EXPIRES_IN = "24h";

export function signJwt(claims: JwtClaims): string {
  return jwt.sign(claims, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

export function verifyJwt(token: string): JwtClaims {
  return jwt.verify(token, getJwtSecret()) as JwtClaims;
}

export async function getUserById(userId: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return result[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return result[0] ?? null;
}

export async function getUserByAzureId(azureAdId: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.azureAdId, azureAdId))
    .limit(1);
  return result[0] ?? null;
}

export async function getDevUsers() {
  const result = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      officeId: users.officeId,
    })
    .from(users)
    .where(eq(users.isActive, true));
  return result;
}

export async function canAccessOffice(userId: string, officeId: string): Promise<boolean> {
  // Check if it's the user's primary office
  const user = await getUserById(userId);
  if (!user) return false;
  if (user.officeId === officeId) return true;

  // Check user_office_access
  const access = await db
    .select()
    .from(userOfficeAccess)
    .where(eq(userOfficeAccess.userId, userId))
    .limit(100);

  return access.some((a) => a.officeId === officeId);
}
```

> **Issue #15 fix:** `getJwtSecret()` throws in production if `JWT_SECRET` is not set, preventing the app from starting with a fallback secret.

- [ ] **Step 5: Create server/src/middleware/auth.ts**

```typescript
import type { Request, Response, NextFunction } from "express";
import { verifyJwt, getUserById, canAccessOffice } from "../modules/auth/service.js";
import { AppError } from "./error-handler.js";
import type { AuthenticatedUser } from "@trock-crm/shared/types";

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    // Extract token from cookie or Authorization header
    const token =
      req.cookies?.token ||
      req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      throw new AppError(401, "Authentication required");
    }

    const claims = verifyJwt(token);
    const user = await getUserById(claims.userId);

    if (!user || !user.isActive) {
      throw new AppError(401, "User not found or inactive");
    }

    // Determine active office (header override or default)
    const requestedOfficeId = req.headers["x-office-id"] as string | undefined;
    let activeOfficeId = user.officeId;

    if (requestedOfficeId && requestedOfficeId !== user.officeId) {
      const hasAccess = await canAccessOffice(user.id, requestedOfficeId);
      if (!hasAccess) {
        throw new AppError(403, "No access to requested office");
      }
      activeOfficeId = requestedOfficeId;
    }

    req.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      officeId: user.officeId,
      activeOfficeId,
    };

    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
    } else {
      next(new AppError(401, "Invalid or expired token"));
    }
  }
}
```

- [ ] **Step 6: Create server/src/modules/auth/routes.ts**

```typescript
import { Router } from "express";
import { getDevUsers, getUserByEmail, signJwt } from "./service.js";
import { authMiddleware } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rate-limit.js";
import { AppError } from "../../middleware/error-handler.js";

const router = Router();

// Dev-mode: list available users for picker
router.get("/dev/users", authLimiter, async (_req, res, next) => {
  try {
    if (process.env.AZURE_CLIENT_ID) {
      throw new AppError(404, "Dev mode not available");
    }
    const devUsers = await getDevUsers();
    res.json({ users: devUsers });
  } catch (err) {
    next(err);
  }
});

// Dev-mode: login as a specific user
router.post("/dev/login", authLimiter, async (req, res, next) => {
  try {
    if (process.env.AZURE_CLIENT_ID) {
      throw new AppError(404, "Dev mode not available");
    }
    const { email } = req.body;
    if (!email) {
      throw new AppError(400, "Email is required");
    }

    const user = await getUserByEmail(email);
    if (!user) {
      throw new AppError(404, "User not found");
    }

    // Issue #16 fix: check isActive before issuing token
    if (!user.isActive) {
      throw new AppError(403, "User is inactive");
    }

    const token = signJwt({
      userId: user.id,
      email: user.email,
      officeId: user.officeId,
      role: user.role,
    });

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        officeId: user.officeId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// MS Entra SSO routes — will be added when Azure credentials are provided.
// For MVP, the dev-mode user picker handles authentication.
// TODO: POST /api/auth/sso/callback — exchange authorization code for tokens
// TODO: GET /api/auth/sso/login — redirect to Microsoft authorization endpoint

// Get current user
router.get("/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// Logout
router.post("/logout", (_req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

export const authRoutes = router;
```

> **Issue #16 fix:** Dev login checks `user.isActive` before issuing a JWT.
> **Issue #24 fix:** SSO routes are documented as TODO comments. Dev-mode user picker is the MVP auth path.

- [ ] **Step 7: Write auth tests**

Create `server/tests/modules/auth.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { signJwt, verifyJwt } from "../../src/modules/auth/service.js";
import type { JwtClaims } from "@trock-crm/shared/types";

describe("JWT auth", () => {
  const claims: JwtClaims = {
    userId: "550e8400-e29b-41d4-a716-446655440000",
    email: "test@trock.dev",
    officeId: "660e8400-e29b-41d4-a716-446655440000",
    role: "rep",
  };

  it("should sign and verify a JWT", () => {
    const token = signJwt(claims);
    const decoded = verifyJwt(token);
    expect(decoded.userId).toBe(claims.userId);
    expect(decoded.email).toBe(claims.email);
    expect(decoded.role).toBe(claims.role);
  });

  it("should reject an invalid token", () => {
    expect(() => verifyJwt("invalid.token.here")).toThrow();
  });

  it("should reject a tampered token", () => {
    const token = signJwt(claims);
    const tampered = token.slice(0, -5) + "xxxxx";
    expect(() => verifyJwt(tampered)).toThrow();
  });

  it("should include all required claims in the token payload", () => {
    const token = signJwt(claims);
    const decoded = verifyJwt(token);
    expect(decoded).toMatchObject({
      userId: claims.userId,
      email: claims.email,
      officeId: claims.officeId,
      role: claims.role,
    });
    // JWT should also have standard claims
    expect(decoded).toHaveProperty("iat");
    expect(decoded).toHaveProperty("exp");
  });
});
```

- [ ] **Step 8: Run tests**

Run: `npm run test --workspace=server`
Expected: All 4 JWT tests pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add JWT auth with dev-mode user picker, RBAC types, and auth routes"
```

---

## Task 7: Multi-Office Tenant Middleware (Transaction + search_path + audit setter)

**Files:**
- Create: `server/src/middleware/tenant.ts`
- Create: `server/src/middleware/rbac.ts`
- Test: `server/tests/middleware/tenant.test.ts`

- [ ] **Step 1: Create server/src/middleware/tenant.ts**

> **Issue #9 fix:** Complete rewrite using the commit-helper pattern. Route handlers call `req.commitTransaction()` before sending a response, ensuring the DB commit happens before the HTTP response is sent. The cleanup handler on `res.close`/`res.error` handles rollback if `commitTransaction()` was never called (error path, client disconnect).
>
> **Issue #8 fix:** Parameter name is `res` (not `_res`) since it's used for cleanup event listeners.
>
> **Issue #10 fix:** Uses `SELECT set_config($1, $2, true)` with parameterized values instead of string interpolation for SET LOCAL statements.

```typescript
import type { Request, Response, NextFunction } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { AppError } from "./error-handler.js";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";

// Extend Express Request with tenant DB and transaction helpers
declare global {
  namespace Express {
    interface Request {
      tenantDb?: ReturnType<typeof drizzle>;
      officeSlug?: string;
      tenantClient?: PoolClient;
      commitTransaction: () => Promise<void>;
    }
  }
}

export async function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError(401, "Authentication required for tenant resolution"));
  }

  const client = await pool.connect();
  let committed = false;

  try {
    // Look up office slug
    const officeResult = await client.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
      [req.user.activeOfficeId]
    );

    if (officeResult.rows.length === 0) {
      client.release();
      return next(new AppError(404, "Office not found or inactive"));
    }

    const officeSlug = officeResult.rows[0].slug;
    const schemaName = `office_${officeSlug}`;

    // Validate schema exists
    const schemaCheck = await client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
      [schemaName]
    );

    if (schemaCheck.rows.length === 0) {
      client.release();
      return next(new AppError(500, `Office schema ${schemaName} does not exist`));
    }

    // Begin transaction
    await client.query("BEGIN");

    // Set search_path and audit user via parameterized set_config (Issue #10 fix)
    await client.query("SELECT set_config('search_path', $1, true)", [`${schemaName},public`]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [req.user.id]);

    // Create a Drizzle instance bound to this client
    req.tenantDb = drizzle(client, { schema });
    req.officeSlug = officeSlug;
    req.tenantClient = client;

    // Commit helper — route handlers call this before sending a response
    req.commitTransaction = async () => {
      if (!committed) {
        committed = true;
        await client.query("COMMIT");
        client.release();
      }
    };

    // Cleanup on connection close or error — rollback if commit never happened
    const cleanup = async () => {
      if (!committed) {
        committed = true;
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    };
    res.on("close", cleanup);
    res.on("error", cleanup);

    next();
  } catch (err) {
    if (!committed) {
      committed = true;
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    next(err);
  }
}
```

**Usage in route handlers:**
```typescript
// Example (for future plans — shows the commit-before-response pattern)
router.get("/deals", authMiddleware, tenantMiddleware, async (req, res, next) => {
  try {
    const result = await req.tenantDb!.select().from(deals);
    await req.commitTransaction();
    res.json({ deals: result });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2: Create server/src/middleware/rbac.ts**

```typescript
import type { Request, Response, NextFunction } from "express";
import { AppError } from "./error-handler.js";
import type { UserRole } from "@trock-crm/shared/types";

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, "Authentication required"));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(403, `Requires one of: ${allowedRoles.join(", ")}`)
      );
    }

    next();
  };
}

export const requireAdmin = requireRole("admin");
export const requireDirector = requireRole("admin", "director");
export const requireAnyRole = requireRole("admin", "director", "rep");
```

- [ ] **Step 3: Write tenant middleware tests**

> **Issue #26 fix:** Real unit tests that test actual logic, not `expect(true).toBe(true)` placeholders.

Create `server/tests/middleware/tenant.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireRole, requireAdmin, requireDirector } from "../../src/middleware/rbac.js";
import { AppError } from "../../src/middleware/error-handler.js";
import type { AuthenticatedUser } from "@trock-crm/shared/types";

function mockReq(user?: Partial<AuthenticatedUser>): Partial<Request> {
  return {
    user: user
      ? {
          id: "test-id",
          email: "test@trock.dev",
          displayName: "Test User",
          role: "rep",
          officeId: "office-1",
          activeOfficeId: "office-1",
          ...user,
        }
      : undefined,
  };
}

function mockRes(): Partial<Response> {
  return {};
}

describe("rbac middleware", () => {
  it("requireRole should call next() for an allowed role", () => {
    const middleware = requireRole("admin", "director");
    const next = vi.fn();
    middleware(
      mockReq({ role: "admin" }) as Request,
      mockRes() as Response,
      next
    );
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // called with no args = success
  });

  it("requireRole should call next(AppError) for a disallowed role", () => {
    const middleware = requireRole("admin", "director");
    const next = vi.fn();
    middleware(
      mockReq({ role: "rep" }) as Request,
      mockRes() as Response,
      next
    );
    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
  });

  it("requireRole should return 401 when no user is on the request", () => {
    const middleware = requireRole("admin");
    const next = vi.fn();
    middleware(
      mockReq() as Request,
      mockRes() as Response,
      next
    );
    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(401);
  });

  it("requireAdmin should only allow admin role", () => {
    const next = vi.fn();
    requireAdmin(mockReq({ role: "admin" }) as Request, mockRes() as Response, next);
    expect(next).toHaveBeenCalledWith(); // success

    const next2 = vi.fn();
    requireAdmin(mockReq({ role: "director" }) as Request, mockRes() as Response, next2);
    const err = next2.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
  });

  it("requireDirector should allow admin and director", () => {
    const nextAdmin = vi.fn();
    requireDirector(mockReq({ role: "admin" }) as Request, mockRes() as Response, nextAdmin);
    expect(nextAdmin).toHaveBeenCalledWith();

    const nextDirector = vi.fn();
    requireDirector(mockReq({ role: "director" }) as Request, mockRes() as Response, nextDirector);
    expect(nextDirector).toHaveBeenCalledWith();

    const nextRep = vi.fn();
    requireDirector(mockReq({ role: "rep" }) as Request, mockRes() as Response, nextRep);
    const err = nextRep.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
  });
});

describe("tenant middleware", () => {
  it("should reject requests without authentication", async () => {
    // Import dynamically to avoid DB connection on module load
    const { tenantMiddleware } = await import("../../src/middleware/tenant.js");
    const req = mockReq() as Request; // no user
    const res = mockRes() as Response;
    const next = vi.fn();

    await tenantMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(401);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm run test --workspace=server`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add tenant middleware (per-request transaction, search_path, audit setter) and RBAC guards"
```

---

## Task 8: Event Bus (EventEmitter + PG LISTEN/NOTIFY)

**Files:**
- Create: `server/src/events/bus.ts`
- Create: `server/src/events/types.ts`
- Test: `server/tests/events/bus.test.ts`

- [ ] **Step 1: Create server/src/events/types.ts**

```typescript
export { DOMAIN_EVENTS, type DomainEvent, type DomainEventName } from "@trock-crm/shared/types";

// Channel name for PG NOTIFY
export const PG_NOTIFY_CHANNEL = "crm_events";
```

- [ ] **Step 2: Create server/src/events/bus.ts**

> **Issue #11 fix:** Uses `SELECT pg_notify($1, $2)` with parameterized values instead of manual string escaping in NOTIFY.
> **Issue #20 fix:** `emitRemote` actually writes to the `job_queue` table as the outbox pattern requires.

```typescript
import { EventEmitter } from "events";
import { pool } from "../db.js";
import { PG_NOTIFY_CHANNEL, type DomainEvent, type DomainEventName } from "./types.js";

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Emit an in-process event (handled within the API server).
   * Use for: SSE notifications, activity logging, in-request side effects.
   */
  emitLocal(event: DomainEvent) {
    this.emit(event.name, event);
  }

  /**
   * Emit a cross-process event via PG NOTIFY + job_queue outbox.
   * Use for: Worker-bound jobs (Procore sync, email tasks, alert emails).
   * Writes to job_queue as outbox pattern fallback for durability.
   */
  async emitRemote(event: DomainEvent) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Write to job_queue as durable outbox (Issue #20 fix)
      // Uses generic 'domain_event' job_type — worker dispatches by event name in payload
      await client.query(
        `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
         VALUES ($1, $2, $3, 'pending', NOW())`,
        ["domain_event", JSON.stringify({ eventName: event.name, ...event.payload, userId: event.userId }), event.officeId]
      );

      // Notify worker for real-time pickup (Issue #11 fix — parameterized)
      const payload = JSON.stringify({
        ...event,
        timestamp: event.timestamp.toISOString(),
      });
      await client.query("SELECT pg_notify($1, $2)", [PG_NOTIFY_CHANNEL, payload]);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[EventBus] emitRemote failed:", err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Emit both local and remote.
   * Use for events that need both in-process and worker handling.
   */
  async emitAll(event: DomainEvent) {
    this.emitLocal(event);
    await this.emitRemote(event);
  }

  /**
   * Subscribe to a specific event type.
   */
  onEvent(eventName: DomainEventName, handler: (event: DomainEvent) => void) {
    this.on(eventName, handler);
    return this;
  }
}

export const eventBus = new EventBus();
```

- [ ] **Step 3: Write event bus tests**

Create `server/tests/events/bus.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { DOMAIN_EVENTS, type DomainEvent } from "../../src/events/types.js";

describe("EventBus", () => {
  it("should emit and receive local events", () => {
    const bus = new EventEmitter();
    const handler = vi.fn();

    bus.on(DOMAIN_EVENTS.DEAL_WON, handler);

    const event: DomainEvent = {
      name: DOMAIN_EVENTS.DEAL_WON,
      payload: { dealId: "123", dealName: "Test Deal" },
      officeId: "office-1",
      userId: "user-1",
      timestamp: new Date(),
    };

    bus.emit(event.name, event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("should support multiple listeners for the same event", () => {
    const bus = new EventEmitter();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on(DOMAIN_EVENTS.DEAL_STAGE_CHANGED, handler1);
    bus.on(DOMAIN_EVENTS.DEAL_STAGE_CHANGED, handler2);

    const event: DomainEvent = {
      name: DOMAIN_EVENTS.DEAL_STAGE_CHANGED,
      payload: { dealId: "123" },
      officeId: "office-1",
      userId: "user-1",
      timestamp: new Date(),
    };

    bus.emit(event.name, event);

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it("should not cross-fire between different event types", () => {
    const bus = new EventEmitter();
    const wonHandler = vi.fn();
    const lostHandler = vi.fn();

    bus.on(DOMAIN_EVENTS.DEAL_WON, wonHandler);
    bus.on(DOMAIN_EVENTS.DEAL_LOST, lostHandler);

    bus.emit(DOMAIN_EVENTS.DEAL_WON, { name: DOMAIN_EVENTS.DEAL_WON });

    expect(wonHandler).toHaveBeenCalledOnce();
    expect(lostHandler).not.toHaveBeenCalled();
  });

  it("should serialize DomainEvent timestamp to ISO string for PG NOTIFY payload", () => {
    const event: DomainEvent = {
      name: DOMAIN_EVENTS.DEAL_WON,
      payload: { dealId: "123" },
      officeId: "office-1",
      userId: "user-1",
      timestamp: new Date("2026-04-01T12:00:00Z"),
    };

    // Simulate what emitRemote does
    const serialized = JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString(),
    });
    const parsed = JSON.parse(serialized);

    // Issue #28: timestamp becomes a string after JSON serialization
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.timestamp).toBe("2026-04-01T12:00:00.000Z");

    // Worker must parse it back to Date
    const restored = new Date(parsed.timestamp);
    expect(restored.getTime()).toBe(event.timestamp.getTime());
  });
});
```

> **Issue #28 fix:** Test explicitly validates the Date serialization/deserialization roundtrip that happens through PG NOTIFY.

- [ ] **Step 4: Run tests**

Run: `npm run test --workspace=server`
Expected: All event bus tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add event bus with local EventEmitter, PG NOTIFY, and job_queue outbox"
```

---

## Task 9: Worker Service — Entry Point + PG Listener + Job Queue Poller

**Files:**
- Create: `worker/src/db.ts`
- Create: `worker/src/listener.ts`
- Create: `worker/src/queue.ts`
- Create: `worker/src/jobs/index.ts`
- Create: `worker/src/index.ts`

- [ ] **Step 1: Create worker/src/db.ts**

```typescript
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

export const db = drizzle(pool, { schema });
export { pool };
```

- [ ] **Step 2: Create worker/src/listener.ts**

> **Issue #12 fix:** Reconnect logic closes the old client before creating a new one, and uses a `reconnecting` guard to prevent stacking duplicate listeners.
> **Issue #28 fix:** Parses `event.timestamp` back to a Date object after JSON deserialization.

```typescript
import pg from "pg";

const PG_NOTIFY_CHANNEL = "crm_events";

let activeClient: pg.Client | null = null;
let reconnecting = false;

export async function startListener(onEvent: (event: any) => void): Promise<pg.Client> {
  // Close existing client if reconnecting (Issue #12 fix)
  if (activeClient) {
    activeClient.removeAllListeners();
    await activeClient.end().catch(() => {});
    activeClient = null;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  activeClient = client;

  await client.connect();
  await client.query(`LISTEN ${PG_NOTIFY_CHANNEL}`);

  client.on("notification", (msg) => {
    if (msg.channel === PG_NOTIFY_CHANNEL && msg.payload) {
      try {
        const event = JSON.parse(msg.payload);
        // Issue #28 fix: parse timestamp string back to Date
        if (event.timestamp && typeof event.timestamp === "string") {
          event.timestamp = new Date(event.timestamp);
        }
        onEvent(event);
      } catch (err) {
        console.error("[Worker] Failed to parse event:", err);
      }
    }
  });

  client.on("error", async (err) => {
    console.error("[Worker] PG listener error:", err);
    // Reconnect with guard to prevent stacking (Issue #12 fix)
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(async () => {
        try {
          await startListener(onEvent);
        } catch (reconnectErr) {
          console.error("[Worker] Reconnect failed:", reconnectErr);
        } finally {
          reconnecting = false;
        }
      }, 5000);
    }
  });

  console.log(`[Worker] Listening on PG channel: ${PG_NOTIFY_CHANNEL}`);
  return client;
}
```

- [ ] **Step 3: Create worker/src/queue.ts**

> **Issue #21 fix:** Sets `started_processing_at` when marking a job as 'processing'. Stale job recovery checks `started_processing_at` instead of `created_at`.

```typescript
import { pool } from "./db.js";

type JobHandler = (payload: any, officeId: string | null) => Promise<void>;

const jobHandlers = new Map<string, JobHandler>();

export function registerJobHandler(jobType: string, handler: JobHandler) {
  jobHandlers.set(jobType, handler);
}

export async function pollJobs() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Grab the next pending job (FOR UPDATE SKIP LOCKED prevents double-processing)
    const result = await client.query(
      `SELECT * FROM public.job_queue
       WHERE status = 'pending' AND run_after <= NOW()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );

    if (result.rows.length === 0) {
      await client.query("COMMIT");
      return;
    }

    const job = result.rows[0];
    const handler = jobHandlers.get(job.job_type);

    if (!handler) {
      console.warn(`[Worker] No handler for job type: ${job.job_type}`);
      await client.query(
        "UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2",
        [`No handler registered for job type: ${job.job_type}`, job.id]
      );
      await client.query("COMMIT");
      return;
    }

    // Mark as processing with timestamp (Issue #21 fix)
    await client.query(
      "UPDATE public.job_queue SET status = 'processing', attempts = attempts + 1, started_processing_at = NOW() WHERE id = $1",
      [job.id]
    );
    await client.query("COMMIT");

    // Execute handler
    try {
      await handler(job.payload, job.office_id);
      await pool.query(
        "UPDATE public.job_queue SET status = 'completed', completed_at = NOW() WHERE id = $1",
        [job.id]
      );
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      const newAttempts = job.attempts + 1;

      if (newAttempts >= job.max_attempts) {
        await pool.query(
          "UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2",
          [errorMsg, job.id]
        );
        console.error(`[Worker] Job ${job.id} (${job.job_type}) dead after ${newAttempts} attempts: ${errorMsg}`);
      } else {
        // Exponential backoff: 3s, 9s, 27s
        const backoffSeconds = Math.pow(3, newAttempts);
        await pool.query(
          "UPDATE public.job_queue SET status = 'pending', last_error = $1, run_after = NOW() + make_interval(secs => $2) WHERE id = $3",
          [errorMsg, backoffSeconds, job.id]
        );
        console.warn(`[Worker] Job ${job.id} (${job.job_type}) failed, retrying in ${backoffSeconds}s: ${errorMsg}`);
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[Worker] Poll error:", err);
  } finally {
    client.release();
  }
}

/**
 * Reset stale "processing" jobs back to pending.
 * Uses started_processing_at (not created_at) to detect truly stuck jobs. (Issue #21 fix)
 * Called on worker startup to recover from crashes.
 */
export async function recoverStaleJobs() {
  const result = await pool.query(
    `UPDATE public.job_queue
     SET status = 'pending', last_error = 'Recovered from stale processing state'
     WHERE status = 'processing'
       AND started_processing_at < NOW() - interval '5 minutes'
     RETURNING id, job_type`
  );
  if (result.rows.length > 0) {
    console.log(`[Worker] Recovered ${result.rows.length} stale jobs:`,
      result.rows.map((r) => `${r.id}:${r.job_type}`).join(", ")
    );
  }
}
```

- [ ] **Step 4: Create worker/src/jobs/index.ts**

> **Issue #23 fix:** Registers a `test_echo` handler that validates the queue works end-to-end.

```typescript
import { registerJobHandler } from "../queue.js";

/**
 * Test handler that logs the payload. Used to validate the queue works end-to-end.
 * Insert a test job: INSERT INTO job_queue (job_type, payload) VALUES ('test_echo', '{"message":"hello"}');
 */
async function handleTestEcho(payload: any, officeId: string | null): Promise<void> {
  console.log(`[Worker:test_echo] Received payload:`, JSON.stringify(payload));
  console.log(`[Worker:test_echo] Office ID: ${officeId ?? "none"}`);
  // Simulate some work
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(`[Worker:test_echo] Done.`);
}

/**
 * Generic domain event handler. emitRemote() writes all cross-process events
 * with job_type = 'domain_event'. This handler dispatches by eventName in payload.
 * Unknown events are logged and completed (not marked dead) — real handlers
 * are added as each feature plan is implemented.
 */
const domainEventHandlers = new Map<string, (payload: any, officeId: string | null) => Promise<void>>();

async function handleDomainEvent(payload: any, officeId: string | null): Promise<void> {
  const eventName = payload.eventName;
  console.log(`[Worker:domain_event] Received: ${eventName}`);

  const handler = domainEventHandlers.get(eventName);
  if (handler) {
    await handler(payload, officeId);
  } else {
    console.log(`[Worker:domain_event] No handler for '${eventName}' yet — completing without action`);
  }
}

export function registerAllJobs() {
  registerJobHandler("test_echo", handleTestEcho);
  registerJobHandler("domain_event", handleDomainEvent);

  // Future domain event handlers added here as features are built:
  // domainEventHandlers.set("deal.won", handleDealWon);
  // domainEventHandlers.set("deal.stage.changed", handleDealStageChanged);

  console.log("[Worker] Job handlers registered:", ["test_echo", "domain_event"].join(", "));
}

export { domainEventHandlers };
```

- [ ] **Step 5: Create worker/src/index.ts**

```typescript
import dotenv from "dotenv";
dotenv.config();

import { startListener } from "./listener.js";
import { pollJobs, recoverStaleJobs } from "./queue.js";
import { registerAllJobs } from "./jobs/index.js";

const POLL_INTERVAL_MS = 2000; // Poll job queue every 2 seconds

async function main() {
  console.log("[Worker] Starting T Rock CRM Worker...");

  // Register job handlers
  registerAllJobs();

  // Recover stale jobs from previous crashes
  await recoverStaleJobs();

  // Start PG LISTEN for real-time events
  await startListener((event) => {
    console.log(`[Worker] Received event: ${event.name}`, {
      officeId: event.officeId,
      timestamp: event.timestamp,
    });
    // Event-specific handlers will be wired here as features are built
  });

  // Start job queue polling
  setInterval(pollJobs, POLL_INTERVAL_MS);
  console.log(`[Worker] Polling job queue every ${POLL_INTERVAL_MS}ms`);

  console.log("[Worker] Ready.");
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Verify worker starts**

Run: `npm run dev:worker`
Expected: Console shows:
```
[Worker] Starting T Rock CRM Worker...
[Worker] Job handlers registered: test_echo
[Worker] Listening on PG channel: crm_events
[Worker] Polling job queue every 2000ms
[Worker] Ready.
```

- [ ] **Step 7: Verify test_echo handler works end-to-end**

```bash
psql $DATABASE_URL -c "INSERT INTO job_queue (job_type, payload) VALUES ('test_echo', '{\"message\": \"hello from plan 1\"}')"
```

Expected: Within 2 seconds, worker logs:
```
[Worker:test_echo] Received payload: {"message":"hello from plan 1"}
[Worker:test_echo] Office ID: none
[Worker:test_echo] Done.
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add Worker service with PG listener, job queue poller, stale recovery, and test_echo handler"
```

---

## Task 10: Office Management — CRUD + Schema Provisioning

**Files:**
- Create: `server/src/modules/office/service.ts`
- Create: `server/src/modules/office/routes.ts`
- Test: `server/tests/modules/office.test.ts`

- [ ] **Step 1: Create server/src/modules/office/service.ts**

> **Issue #18 fix:** Office creation wraps the insert + schema provisioning in a single transaction. If provisioning fails, the office row is rolled back.
> **Issue #19 fix:** Provisioning runs all migration files against the new schema instead of calling a static PG function.

```typescript
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db.js";
import { offices } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../../migrations");

export async function getAllOffices() {
  return db.select().from(offices).where(eq(offices.isActive, true));
}

export async function getOfficeById(id: string) {
  const result = await db.select().from(offices).where(eq(offices.id, id)).limit(1);
  return result[0] ?? null;
}

export async function getOfficeBySlug(slug: string) {
  const result = await db.select().from(offices).where(eq(offices.slug, slug)).limit(1);
  return result[0] ?? null;
}

export async function createOffice(name: string, slug: string, address?: string, phone?: string) {
  // Validate slug format
  if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new AppError(400, "Slug must be lowercase alphanumeric with underscores, starting with a letter");
  }

  // Check slug uniqueness
  const existing = await getOfficeBySlug(slug);
  if (existing) {
    throw new AppError(409, `Office with slug '${slug}' already exists`);
  }

  // Issue #18 fix: atomic operation — insert + provision in a single transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create office record
    const insertResult = await client.query(
      `INSERT INTO public.offices (name, slug, address, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, slug, address ?? null, phone ?? null]
    );
    const office = insertResult.rows[0];

    // Provision tenant schema (Issue #19 fix: run migrations, not a static PG function)
    await provisionOfficeSchema(client, slug);

    await client.query("COMMIT");
    console.log(`[Office] Created office '${name}' with schema office_${slug}`);
    return office;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[Office] Failed to create office '${name}':`, err);
    if (err instanceof AppError) throw err;
    throw new AppError(500, `Failed to create office: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

/**
 * Provision a new office schema by creating the schema and running all
 * tenant-related DDL from migration files.
 *
 * Issue #19 fix: Instead of a static PG function (which would go stale as
 * new migrations add columns/tables), this reads the tenant DDL section from
 * each migration file. For the initial migration, the tenant DDL is the
 * section between markers `-- TENANT_SCHEMA_START` and `-- TENANT_SCHEMA_END`.
 * The runner replaces the placeholder schema name with the actual office schema.
 */
async function provisionOfficeSchema(client: import("pg").PoolClient, slug: string) {
  const schemaName = `office_${slug}`;

  // Create the schema
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

  // Read migration files and extract tenant DDL sections
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

    // Extract tenant DDL between markers
    const startMarker = "-- TENANT_SCHEMA_START";
    const endMarker = "-- TENANT_SCHEMA_END";
    const startIdx = sql.indexOf(startMarker);
    const endIdx = sql.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) continue;

    let tenantSql = sql.substring(startIdx + startMarker.length, endIdx).trim();

    // Replace placeholder schema name with actual office schema
    tenantSql = tenantSql.replace(/office_dallas/g, schemaName);

    // Set search path for this schema
    await client.query(`SET LOCAL search_path = '${schemaName}', 'public'`);
    await client.query(tenantSql);
  }

  console.log(`[Office] Provisioned schema: ${schemaName}`);
}
```

- [ ] **Step 2: Create server/src/modules/office/routes.ts**

> **Issue #17 fix:** Office list and single office endpoints require admin role, matching the spec's RBAC table.

```typescript
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { getAllOffices, getOfficeById, createOffice } from "./service.js";
import { AppError } from "../../middleware/error-handler.js";

const router = Router();

// List all offices (admin only — Issue #17 fix)
router.get("/", authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const officeList = await getAllOffices();
    res.json({ offices: officeList });
  } catch (err) {
    next(err);
  }
});

// Get single office (admin only — Issue #17 fix)
router.get("/:id", authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const office = await getOfficeById(req.params.id);
    if (!office) throw new AppError(404, "Office not found");
    res.json({ office });
  } catch (err) {
    next(err);
  }
});

// Create new office (admin only)
router.post("/", authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const { name, slug, address, phone } = req.body;
    if (!name || !slug) {
      throw new AppError(400, "Name and slug are required");
    }
    const office = await createOffice(name, slug, address, phone);
    res.status(201).json({ office });
  } catch (err) {
    next(err);
  }
});

export const officeRoutes = router;
```

- [ ] **Step 3: Create server/src/modules/notifications/routes.ts**

> **Issue #27 fix:** Basic SSE endpoint for real-time notifications. Sends keepalive pings every 30 seconds. Event handlers will push real notifications in later plans.

```typescript
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";

const router = Router();

// SSE notification stream
router.get("/stream", authMiddleware, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering on Railway
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ userId: req.user!.id })}\n\n`);

  // Keepalive ping every 30 seconds
  const keepalive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 30000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(keepalive);
  });

  // TODO: In later plans, subscribe to eventBus for this user's notifications
  // and push them as SSE events:
  // eventBus.on("notification.created", (event) => {
  //   if (event.payload.userId === req.user!.id) {
  //     res.write(`event: notification\ndata: ${JSON.stringify(event.payload)}\n\n`);
  //   }
  // });
});

export const notificationRoutes = router;
```

- [ ] **Step 4: Verify office creation**

Run: `npm run dev:server`

```bash
# Login as admin
curl -X POST http://localhost:3001/api/auth/dev/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@trock.dev"}' -c cookies.txt

# List offices
curl http://localhost:3001/api/offices -b cookies.txt

# Create new office
curl -X POST http://localhost:3001/api/offices \
  -H "Content-Type: application/json" \
  -d '{"name":"Houston","slug":"houston","address":"Houston, TX"}' \
  -b cookies.txt
```

Expected: Dallas office listed. Houston created with schema provisioned.

Verify: `psql $DATABASE_URL -c "\dt office_houston.*"`
Expected: All tenant tables exist in the new schema.

- [ ] **Step 5: Verify SSE endpoint**

```bash
curl -N http://localhost:3001/api/notifications/stream -b cookies.txt
```

Expected: Receives `event: connected` followed by keepalive pings every 30 seconds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add office CRUD with atomic schema provisioning, admin-only guards, and SSE notification endpoint"
```

---

## Task 11: Frontend — Auth Context + Dev Login + App Shell Layout

**Files:**
- Create: `client/src/lib/api.ts`
- Create: `client/src/lib/auth.tsx`
- Create: `client/src/components/auth/dev-user-picker.tsx`
- Create: `client/src/components/layout/sidebar.tsx`
- Create: `client/src/components/layout/topbar.tsx`
- Create: `client/src/components/layout/mobile-nav.tsx`
- Create: `client/src/components/layout/app-shell.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Create client/src/lib/api.ts**

```tsx
const API_BASE = "/api";

interface ApiOptions extends RequestInit {
  json?: Record<string, any>;
}

export async function api<T = any>(path: string, options: ApiOptions = {}): Promise<T> {
  const { json, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string>),
  };

  if (json) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(json);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers,
    credentials: "include",
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: "Request failed" } }));
    throw new Error(error.error?.message || `HTTP ${res.status}`);
  }

  return res.json();
}
```

- [ ] **Step 2: Create client/src/lib/auth.tsx**

> **Issue #7 fix:** Uses `import type { ReactNode } from "react"` instead of `React.ReactNode`.

```tsx
import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { api } from "./api";

interface User {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "director" | "rep";
  officeId: string;
  activeOfficeId?: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    try {
      const data = await api<{ user: User }>("/auth/me");
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const login = async (email: string) => {
    const data = await api<{ user: User }>("/auth/dev/login", {
      method: "POST",
      json: { email },
    });
    setUser(data.user);
  };

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
```

- [ ] **Step 3: Create client/src/components/auth/dev-user-picker.tsx**

```tsx
import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface DevUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export function DevUserPicker() {
  const { login } = useAuth();
  const [users, setUsers] = useState<DevUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ users: DevUser[] }>("/auth/dev/users")
      .then((data) => setUsers(data.users))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>;

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center">
            <span className="text-brand-purple font-bold">T Rock CRM</span>
            <p className="text-sm text-muted-foreground mt-1">Dev Mode -- Select a user</p>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {users.map((user) => (
            <Button
              key={user.id}
              variant="outline"
              className="w-full justify-between h-auto py-3"
              onClick={() => login(user.email)}
            >
              <span>{user.displayName}</span>
              <Badge variant="secondary">{user.role}</Badge>
            </Button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
```

> **Issue #25 (login page):** The dev-user-picker IS the login page for MVP. No separate login-page.tsx is needed since SSO is deferred.

- [ ] **Step 4: Create client/src/components/layout/sidebar.tsx**

```tsx
import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import {
  LayoutDashboard,
  Kanban,
  Users,
  Mail,
  CheckSquare,
  FileImage,
  BarChart3,
  Building2,
  Settings,
  Shield,
  LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", roles: ["admin", "director", "rep"] },
  { to: "/pipeline", icon: Kanban, label: "Pipeline", roles: ["admin", "director", "rep"] },
  { to: "/contacts", icon: Users, label: "Contacts", roles: ["admin", "director", "rep"] },
  { to: "/email", icon: Mail, label: "Email", roles: ["admin", "director", "rep"] },
  { to: "/tasks", icon: CheckSquare, label: "Tasks", roles: ["admin", "director", "rep"] },
  { to: "/files", icon: FileImage, label: "Files", roles: ["admin", "director", "rep"] },
  { to: "/reports", icon: BarChart3, label: "Reports", roles: ["admin", "director", "rep"] },
  { to: "/projects", icon: Building2, label: "Projects", roles: ["admin", "director", "rep"] },
];

const directorItems = [
  { to: "/director", icon: Shield, label: "Director", roles: ["admin", "director"] },
];

const adminItems = [
  { to: "/admin/offices", icon: Building2, label: "Offices", roles: ["admin"] },
  { to: "/admin/users", icon: Users, label: "Users", roles: ["admin"] },
  { to: "/admin/pipeline", icon: Settings, label: "Pipeline Config", roles: ["admin"] },
];

export function Sidebar() {
  const { user, logout } = useAuth();

  const filterByRole = (items: typeof navItems) =>
    items.filter((item) => user && item.roles.includes(user.role));

  return (
    <aside className="hidden md:flex flex-col w-60 bg-sidebar-bg text-white min-h-screen">
      <div className="p-4">
        <h1 className="text-lg font-bold bg-gradient-to-r from-brand-purple to-brand-cyan bg-clip-text text-transparent">
          T ROCK CRM
        </h1>
      </div>

      <nav className="flex-1 px-2 space-y-1">
        {filterByRole(navItems).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                isActive
                  ? "bg-sidebar-active border-l-2 border-brand-purple text-white"
                  : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
              }`
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}

        {filterByRole(directorItems).length > 0 && (
          <>
            <Separator className="my-3 bg-slate-700" />
            <p className="px-3 text-xs text-slate-500 uppercase tracking-wider">Director</p>
            {filterByRole(directorItems).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? "bg-sidebar-active border-l-2 border-brand-purple text-white"
                      : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
                  }`
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </>
        )}

        {filterByRole(adminItems).length > 0 && (
          <>
            <Separator className="my-3 bg-slate-700" />
            <p className="px-3 text-xs text-slate-500 uppercase tracking-wider">Admin</p>
            {filterByRole(adminItems).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? "bg-sidebar-active border-l-2 border-brand-purple text-white"
                      : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
                  }`
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      <div className="p-4 border-t border-slate-700">
        <div className="flex items-center justify-between">
          <div className="text-sm">
            <p className="text-white font-medium truncate">{user?.displayName}</p>
            <p className="text-slate-400 text-xs capitalize">{user?.role}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-slate-400 hover:text-white"
            onClick={logout}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 5: Create client/src/components/layout/topbar.tsx**

```tsx
import { Bell, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth } from "@/lib/auth";

export function Topbar() {
  const { user } = useAuth();
  const initials = user?.displayName
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase() ?? "?";

  return (
    <header className="h-14 border-b bg-white flex items-center justify-between px-4 md:px-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <Search className="h-4 w-4 mr-2" />
          <span className="hidden sm:inline">Search...</span>
          <kbd className="hidden md:inline-flex ml-2 text-xs bg-muted px-1.5 py-0.5 rounded">
            Cmd+K
          </kbd>
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-4 w-4" />
        </Button>
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-brand-purple text-white text-xs">
            {initials}
          </AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}
```

- [ ] **Step 6: Create client/src/components/layout/mobile-nav.tsx**

> **Issue #25 fix:** Mobile bottom navigation bar for small screens.

```tsx
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Kanban,
  Users,
  CheckSquare,
  BarChart3,
} from "lucide-react";

const mobileNavItems = [
  { to: "/", icon: LayoutDashboard, label: "Home" },
  { to: "/pipeline", icon: Kanban, label: "Pipeline" },
  { to: "/contacts", icon: Users, label: "Contacts" },
  { to: "/tasks", icon: CheckSquare, label: "Tasks" },
  { to: "/reports", icon: BarChart3, label: "Reports" },
];

export function MobileNav() {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t z-50">
      <div className="flex items-center justify-around h-16">
        {mobileNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-1 min-w-[3rem] min-h-[2.75rem] rounded-md transition-colors ${
                isActive
                  ? "text-brand-purple"
                  : "text-muted-foreground"
              }`
            }
          >
            <item.icon className="h-5 w-5" />
            <span className="text-[10px] font-medium">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 7: Create client/src/components/layout/app-shell.tsx**

```tsx
import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { MobileNav } from "./mobile-nav";

export function AppShell() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <Topbar />
        <main className="flex-1 p-4 md:p-6 bg-slate-50 pb-20 md:pb-6">
          <Outlet />
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
```

- [ ] **Step 8: Update client/src/App.tsx**

> **Issue #7 fix:** Uses `import type { ReactNode } from "react"` instead of `React.ReactNode`.

```tsx
import { Routes, Route, Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DevUserPicker } from "@/components/auth/dev-user-picker";
import { AppShell } from "@/components/layout/app-shell";

function Dashboard() {
  return (
    <div>
      <h2 className="text-2xl font-bold">Dashboard</h2>
      <p className="text-muted-foreground mt-1">Welcome to T Rock CRM. Features coming soon.</p>
    </div>
  );
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div>
      <h2 className="text-2xl font-bold">{title}</h2>
      <p className="text-muted-foreground mt-1">This page will be built in a future plan.</p>
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) return <DevUserPicker />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pipeline" element={<PlaceholderPage title="Pipeline" />} />
            <Route path="/contacts" element={<PlaceholderPage title="Contacts" />} />
            <Route path="/email" element={<PlaceholderPage title="Email" />} />
            <Route path="/tasks" element={<PlaceholderPage title="Tasks" />} />
            <Route path="/files" element={<PlaceholderPage title="Files" />} />
            <Route path="/reports" element={<PlaceholderPage title="Reports" />} />
            <Route path="/projects" element={<PlaceholderPage title="Projects" />} />
            <Route path="/director" element={<PlaceholderPage title="Director Dashboard" />} />
            <Route path="/admin/offices" element={<PlaceholderPage title="Offices" />} />
            <Route path="/admin/users" element={<PlaceholderPage title="Users" />} />
            <Route path="/admin/pipeline" element={<PlaceholderPage title="Pipeline Config" />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthGate>
    </AuthProvider>
  );
}
```

- [ ] **Step 9: Verify full stack runs**

Run: `npm run dev` (starts all three services concurrently)

Expected:
1. Server starts on :3001
2. Worker starts and connects to PG
3. Frontend starts on :5173
4. Browser shows dev user picker
5. Clicking a user logs in and shows the app shell with sidebar
6. Navigation links work, showing placeholder pages
7. Mobile bottom nav visible on small screens
8. Logout returns to user picker

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add frontend auth flow, dev user picker, sidebar layout, mobile nav, and app shell"
```

---

## Task 12: Push to GitHub + Verify Railway Deployment Config

- [ ] **Step 1: Create GitHub repository**

```bash
gh repo create artificialadnaan/trock-crm --private --source=. --remote=origin
```

- [ ] **Step 2: Push initial code**

```bash
git push -u origin main
```

- [ ] **Step 3: Add railway.json files for each service** (if needed)

Railway auto-detects from root directory settings. No `railway.json` at root. Each service configured in Railway UI:
- API: root directory = `server/`, start = `npm start`
- Worker: root directory = `worker/`, start = `npm start`
- Frontend: root directory = `client/`, start = `npm start`

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "chore: push to GitHub, add deployment configs"
git push
```

---

## Verification Checklist

After completing all tasks, verify:

- [ ] `npm run typecheck` passes with zero errors across all workspaces
- [ ] `npm run test` passes all tests (JWT auth, RBAC middleware, tenant middleware, event bus)
- [ ] `npm run dev` starts all three services without errors
- [ ] Dev user picker shows 3 seed users (Admin, Director, Rep)
- [ ] Login as each role shows correct sidebar items (admin sees all, rep sees fewer)
- [ ] Health check returns OK: `curl http://localhost:3001/api/health`
- [ ] Office list restricted to admin: `curl http://localhost:3001/api/offices` (with admin auth)
- [ ] Non-admin gets 403 on office endpoints
- [ ] Database has all public tables: `psql $DATABASE_URL -c "\dt public.*"`
- [ ] Database has office_dallas tenant tables: `psql $DATABASE_URL -c "\dt office_dallas.*"`
- [ ] Pipeline stages are seeded: `psql $DATABASE_URL -c "SELECT * FROM pipeline_stage_config ORDER BY display_order;"`
- [ ] Worker connects to PG and polls job queue
- [ ] test_echo job handler processes successfully
- [ ] Creating a new office provisions its schema atomically
- [ ] SSE endpoint responds with keepalive: `curl -N http://localhost:3001/api/notifications/stream` (with auth)
- [ ] Mobile bottom nav visible at mobile viewport widths
- [ ] Inactive users cannot log in via dev picker

---

## Issue Resolution Summary

| # | Issue | Fix Location |
|---|-------|-------------|
| 1 | `tsc --noEmit --workspaces` doesn't exist | Task 1 Step 1: root typecheck delegates via `npm run typecheck --workspaces`; each workspace has own `typecheck` script |
| 2 | shared exports point to `.ts`, Node can't run them in prod | Task 1 Step 5: exports point to `dist/*.js`; shared builds first via `dev:shared`; `tsx` handles TS in dev |
| 3 | Missing `composite: true` in shared/tsconfig.json | Task 1 Step 6: added `composite: true` |
| 4 | `rootDir: "./src"` conflicts with `include: ["tests/**/*"]` | Task 1 Steps 8/8b: separate `tsconfig.test.json` for tests |
| 5 | `require()` in ESM tailwind config | Task 2 Steps 2/7: ESM import of `tailwindcss-animate` |
| 6 | Missing shadcn CSS variable mappings | Task 2 Steps 6-8: run `shadcn init` FIRST, then modify generated config |
| 7 | `React.ReactNode` without React import | Task 2 Step 12, Task 11 Steps 2/8: `import type { ReactNode } from "react"` |
| 8 | `_res` parameter but uses `res` | Task 7 Step 1: parameter is `res` (used for event listeners) |
| 9 | Tenant middleware race — commit fires after response | Task 7 Step 1: `req.commitTransaction()` pattern — route handler commits before sending response |
| 10 | SQL injection in SET LOCAL | Task 7 Step 1: `SELECT set_config($1, $2, true)` with parameterized values |
| 11 | NOTIFY with manual string escaping | Task 8 Step 2: `SELECT pg_notify($1, $2)` with parameterized values |
| 12 | Worker listener reconnect stacks duplicates | Task 9 Step 2: close old client + `reconnecting` guard |
| 13 | tenantMiddleware never wired into app | Task 5 Step 4: tenantMiddleware wired onto `/api` with `tenant-check` test route |
| 14 | Tenant schema Drizzle definitions missing | Task 3 Step 13: ALL tenant table schemas defined and exported |
| 15 | JWT fallback secret in production | Task 6 Step 4: `getJwtSecret()` throws if not set in production |
| 16 | Dev login doesn't check isActive | Task 6 Step 6: `if (!user.isActive) throw new AppError(403, "User is inactive")` |
| 17 | Office list open to all roles | Task 10 Step 2: `requireAdmin` middleware on GET /offices and GET /offices/:id |
| 18 | Office creation not atomic | Task 10 Step 1: single transaction wraps insert + provision with rollback |
| 19 | `provision_office_schema()` won't stay in sync | Task 10 Step 1: run migration files against new schema instead of static PG function |
| 20 | `emitRemote` never writes to job_queue | Task 8 Step 2: INSERT into job_queue in emitRemote |
| 21 | Stale job recovery uses `created_at` | Task 3 Step 9, Task 9 Step 3: `started_processing_at` column; recovery checks it |
| 22 | `entity_type`/`entity` should be pgEnum | Task 3 Steps 1/11/12: `procoreEntityTypeEnum` and `reportEntityEnum` defined as pgEnum |
| 23 | No job handlers registered | Task 9 Step 4: `test_echo` + `domain_event` handlers; domain_event dispatches by eventName, completes gracefully for unregistered events |
| 24 | MS Entra SSO routes missing | Task 6 Step 6: TODO comments noting SSO deferred; dev picker is MVP auth |
| 25 | login-page.tsx, mobile-nav.tsx not created | Task 11 Steps 3/6: DevUserPicker is the login page; MobileNav created with bottom nav |
| 26 | Tenant/event tests are placeholders | Task 7 Step 3: real unit tests for RBAC and tenant middleware |
| 27 | SSE notification endpoint missing | Task 10 Step 3: `GET /api/notifications/stream` with keepalive pings |
| 28 | Date serialization in PG NOTIFY | Task 8 Step 3, Task 9 Step 2: serialize to ISO string, parse back to Date in worker |
