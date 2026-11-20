FROM oven/bun:1.4.4-debian
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun apps/web/package.json apps/web/package.json
COPY --chown=bun:bun apps/worker/package.json apps/worker/package.json
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun apps/worker/src apps/worker/src
COPY --chown=bun:bun apps/worker/tsconfig.json apps/worker/tsconfig.json
# Shared modules: worker entry resolves @/* via worker tsconfig; web lib files use web tsconfig.
COPY --chown=bun:bun apps/web/src/lib apps/web/src/lib
COPY --chown=bun:bun apps/web/tsconfig.json apps/web/tsconfig.json
USER bun
CMD ["bun", "--no-env-file", "apps/worker/src/index.ts"]
