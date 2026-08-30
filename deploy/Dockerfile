# syntax=docker/dockerfile:1
# Multi-stage: build resolves Bun deps; runtime is the deployable image with
# mariadb-client + zstd installed and hardened (non-root, read-only rootfs,
# tmpfs /tmp set in docker-compose.yml).

FROM oven/bun:1.3.14-debian AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src/

FROM oven/bun:1.3.14-debian AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends mariadb-client zstd \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package.json ./
RUN useradd -r -u 10001 backup
USER backup
ENTRYPOINT ["bun", "run", "src/main.ts"]
