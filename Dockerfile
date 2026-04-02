FROM node:20-alpine AS builder
WORKDIR /app

# Copy everything (dockerignore handles exclusions)
COPY . .

# Install and build
RUN npm install
RUN npm run build --workspace=shared
RUN npm run build --workspace=server
RUN npm run build --workspace=worker
RUN npm run build --workspace=client || true

# API production image
FROM node:20-alpine AS api
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server ./server
COPY --from=builder /app/migrations ./migrations
EXPOSE 3001
CMD ["node", "server/dist/index.js"]

# Worker production image
FROM node:20-alpine AS worker
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/migrations ./migrations
CMD ["node", "worker/dist/index.js"]

# Frontend production image
FROM node:20-alpine AS frontend
WORKDIR /app
RUN npm install -g serve
COPY --from=builder /app/client/dist ./dist
EXPOSE 3000
CMD ["serve", "dist", "-s", "-l", "3000"]
