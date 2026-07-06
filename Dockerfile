FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
ENV NODE_ENV=development
RUN npm ci
RUN npm run build --workspace=shared
RUN npm run build --workspace=server
RUN npm run build --workspace=client

FROM node:20-alpine
WORKDIR /app

# poppler-utils provides `pdftoppm`, used by confirmUpload() to rasterize a PDF's first page into a
# thumbnail (best-effort; a miss falls back to a type badge). The builder stage does not need it.
# `command -v pdftoppm` FAILS THE IMAGE BUILD if the package didn't actually land a runnable binary on
# PATH (wrong name, musl mismatch) — the PDF path is otherwise silent-degrade, so we assert here.
RUN apk add --no-cache poppler-utils && command -v pdftoppm

# Copy package manifests for all workspaces
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install only the runtime deps the API container executes.
RUN npm ci --omit=dev --workspace=shared --workspace=server

# Copy compiled output
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

# Copy migrations
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "-lc", "node server/dist/migrations/runner.js && node server/dist/index.js"]
