FROM oven/bun:1.4.4-debian AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN bun install --frozen-lockfile
COPY apps/web apps/web
# Inlined into the client bundle at build time. Empty keeps browser Sentry off.
# Railway injects matching service variables when these ARG names are declared.
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=$NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
RUN bun run --filter @orbit/web build

FROM oven/bun:1.4.4-debian
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --chown=bun:bun --from=build /app/apps/web/.next/standalone ./
COPY --chown=bun:bun --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=bun:bun --from=build /app/apps/web/public ./apps/web/public
USER bun
EXPOSE 3000
CMD ["bun", "--bun", "apps/web/server.js"]
