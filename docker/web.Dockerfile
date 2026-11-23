FROM oven/bun:1.4.5-debian AS manifests
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json

FROM manifests AS build
RUN bun install --frozen-lockfile
COPY apps/web apps/web
# Inlined into the client bundle at build time. Empty keeps browser Sentry off.
# Railway injects matching service variables when these ARG names are declared.
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=$NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
RUN bun run --filter @orbit/web build \
    && rm -rf apps/web/.next/standalone/node_modules apps/web/.next/standalone/apps/web/node_modules

FROM manifests AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# Install the locked production tree because standalone tracing can omit server externals.
# `postgres` must remain available for pre-deploy and startup migrations.
RUN bun install --frozen-lockfile --production --linker=hoisted
COPY --chown=bun:bun --from=build /app/apps/web/.next/standalone ./
COPY --chown=bun:bun --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=bun:bun --from=build /app/apps/web/public ./apps/web/public
COPY --chown=bun:bun scripts/migrate.ts scripts/start-web.ts ./scripts/
COPY --chown=bun:bun apps/web/drizzle ./apps/web/drizzle
USER bun
EXPOSE 3000
CMD ["bun", "--bun", "--no-env-file", "scripts/start-web.ts"]
