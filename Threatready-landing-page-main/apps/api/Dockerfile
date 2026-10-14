# One image (ADD L1/L20). Build from the repo root:
#   docker build -f apps/api/Dockerfile -t threatready-api .
# Run:      node dist/main.js
# Migrate:  node dist/db/migrate.js   (one-off ECS task before each deploy)
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @threatready/api...
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @threatready/contracts build && pnpm --filter @threatready/api build \
 && pnpm --filter @threatready/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/drizzle /out/

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
