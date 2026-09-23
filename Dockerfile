# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY manifests ./manifests
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache git \
  && addgroup -S orchestrator && adduser -S -G orchestrator -u 10001 orchestrator
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/manifests ./manifests
USER 10001
ENV NODE_ENV=production
ENV ORCHESTRATOR_DATA_ROOT=/tmp/orchestrator-data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node","dist/runtime/main.js"]
