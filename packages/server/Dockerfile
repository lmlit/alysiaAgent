FROM node:22-alpine AS builder
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/core/src packages/core/src/
COPY packages/core/tsconfig.json packages/core/
COPY packages/server/src packages/server/src/
COPY packages/server/tsconfig.json packages/server/
COPY tsconfig.base.json ./
RUN pnpm -r build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/pnpm-workspace.yaml ./
EXPOSE 6185
CMD ["node", "packages/server/dist/bootstrap.js"]
