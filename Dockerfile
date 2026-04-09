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

# Copy package manifests for all workspaces
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install production deps only
RUN npm ci --omit=dev --workspaces

# Copy compiled output
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

# Copy migrations
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "-lc", "node server/dist/migrations/runner.js && node server/dist/index.js"]
