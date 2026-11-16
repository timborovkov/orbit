FROM oven/bun:1.4.4-debian
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
# Optional trusted registry CA for environments with an HTTPS proxy.
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    bun install --frozen-lockfile --production
COPY --chown=bun:bun apps/worker/src apps/worker/src
USER bun
CMD ["bun", "--no-env-file", "apps/worker/src/index.ts"]
