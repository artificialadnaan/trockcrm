FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY worker/package.json worker/
COPY client/package.json client/
RUN npm ci

FROM base AS builder
COPY . .
RUN npm run build --workspace=shared
RUN npm run build --workspace=server
RUN npm run build --workspace=worker
RUN npm run build --workspace=client || true

FROM node:20-alpine AS api
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server ./server
COPY --from=builder /app/migrations ./migrations
EXPOSE 3001
CMD ["node", "server/dist/index.js"]

FROM node:20-alpine AS worker
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/migrations ./migrations
CMD ["node", "worker/dist/index.js"]

FROM node:20-alpine AS frontend
WORKDIR /app
RUN npm install -g serve
COPY --from=builder /app/client/dist ./dist
EXPOSE 3000
CMD ["serve", "dist", "-s", "-l", "3000"]
