FROM oven/bun:1.4.4-debian AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN bun install --frozen-lockfile
COPY apps/web apps/web
RUN bun run --filter @orbit/web build

FROM oven/bun:1.4.4-debian
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER bun
EXPOSE 3000
CMD ["bun", "--bun", "apps/web/server.js"]
