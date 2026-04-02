FROM node:20-alpine AS builder
WORKDIR /app

# Copy everything
COPY . .

# Debug: show what was copied
RUN ls -la && echo "---dirs---" && ls -d */ 2>/dev/null || true

# Install and build - continue even if some workspaces fail
RUN npm install || (echo "npm install failed, trying without workspaces" && npm install --ignore-scripts)
RUN npm run build --workspace=shared || true
RUN npm run build --workspace=server || true
RUN npm run build --workspace=worker || true
RUN npm run build --workspace=client || true

# API production image
FROM node:20-alpine AS api
WORKDIR /app
COPY --from=builder /app .
EXPOSE 3001
CMD ["node", "server/dist/index.js"]

# Worker production image
FROM node:20-alpine AS worker
WORKDIR /app
COPY --from=builder /app .
CMD ["node", "worker/dist/index.js"]

# Frontend production image
FROM node:20-alpine AS frontend
WORKDIR /app
RUN npm install -g serve
COPY --from=builder /app/client/dist ./dist
EXPOSE 3000
CMD ["serve", "dist", "-s", "-l", "3000"]
