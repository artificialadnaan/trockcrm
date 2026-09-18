FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
ENV NODE_ENV=development
# npm ci retried to ride out the intermittent esbuild postinstall ETXTBSY ("text file busy") race in the build
# container: drizzle-kit -> @esbuild-kit nests an esbuild whose install spawns the freshly-written binary to check
# its version, which occasionally loses to the file still being open. Each attempt gets fresh timing.
RUN npm ci || (echo "npm ci failed (transient esbuild ETXTBSY) — retry 1" && sleep 5 && npm ci) || (echo "retry 2" && sleep 10 && npm ci)
RUN npm run build --workspace=shared
RUN npm run build --workspace=server
# The client is built HERE, and Vite inlines `import.meta.env` at build time — it does not read the
# container's environment at runtime. So a variable set on the deployed service reaches the browser
# bundle only if it is declared as a build ARG and present when this line runs. Without it,
# `resolveTrockScopeBaseUrl` is null in every shipped image and the AI-walk panel silently drops its
# "Review in TROCK Scope" link, with nothing anywhere reporting that it was configured and ignored.
ARG VITE_TROCK_SCOPE_URL
ENV VITE_TROCK_SCOPE_URL=$VITE_TROCK_SCOPE_URL
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
RUN npm ci --omit=dev --workspace=shared --workspace=server || (sleep 5 && npm ci --omit=dev --workspace=shared --workspace=server) || (sleep 10 && npm ci --omit=dev --workspace=shared --workspace=server)

# Copy compiled output
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

# Copy migrations
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "-lc", "node server/dist/migrations/runner.js && node server/dist/index.js"]
