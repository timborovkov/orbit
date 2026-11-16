FROM oven/bun:1.4.4-debian
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN bun install --frozen-lockfile --production
COPY apps/worker/src apps/worker/src
USER bun
CMD ["bun", "--no-env-file", "apps/worker/src/index.ts"]
