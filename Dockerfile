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
COPY --from=builder /app .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "-lc", "npm run db:migrate && node server/dist/index.js"]
