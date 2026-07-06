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
RUN npm run build --workspace=client

FROM node:20-alpine
WORKDIR /app

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
