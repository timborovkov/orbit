FROM oven/bun:1.4.4-debian AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
# Optional trusted registry CA for environments with an HTTPS proxy.
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    bun install --frozen-lockfile
COPY apps/web apps/web
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
