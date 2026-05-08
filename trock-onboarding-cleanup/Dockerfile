FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
ENV NODE_ENV=development
RUN npm ci
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist
COPY migrations ./migrations
ENV NODE_ENV=production
EXPOSE 3025
CMD ["node", "server/dist/index.js"]
