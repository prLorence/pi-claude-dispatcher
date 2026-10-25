FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/src/shared ./src/shared
COPY --from=build /app/dist ./dist
ENV PLANS_ROOT=/plans
ENV STATIC_DIR=/app/dist
ENV HOST=0.0.0.0
ENV PORT=4317
EXPOSE 4317
USER bun
CMD ["bun", "run", "src/server/main.ts"]
