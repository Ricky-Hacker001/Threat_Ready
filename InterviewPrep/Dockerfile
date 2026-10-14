# One image, two runtime roles plus migrate (ADD L1, L20, L21).
#   docker run <image>            -> api    (port 3000, behind the ALB)
#   docker run <image> worker     -> pg-boss worker, no inbound port
#   docker run <image> migrate    -> applies SQL migrations, then exits
# Built for linux/arm64 (Fargate ARM). The static SPA is built separately and served by Cloudflare.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run build -w @threatready/shared -w @threatready/contracts -w @threatready/db -w @threatready/api

# Production dependencies of the API workspaces only (the SPA's three.js/React stay out of the image).
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --ignore-scripts -w @threatready/api -w @threatready/shared -w @threatready/contracts -w @threatready/db

FROM node:24-alpine AS runtime
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./
COPY --from=build --chown=app:app /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=app:app /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=app:app /app/packages/contracts/package.json ./packages/contracts/
COPY --from=build --chown=app:app /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=app:app /app/packages/db/package.json ./packages/db/
COPY --from=build --chown=app:app /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=app:app /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=app:app /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=app:app /app/apps/api/dist ./apps/api/dist
COPY --chown=app:app content ./content
COPY --from=build --chown=app:app /app/apps/api/assets ./apps/api/assets
ENV CONTENT_DIR=/app/content/interview
USER app
WORKDIR /app/apps/api
EXPOSE 3000
# Health checks are defined per ECS service: the api role answers /healthz; the worker has no port.
ENTRYPOINT ["node", "dist/main.js"]
CMD ["api"]
