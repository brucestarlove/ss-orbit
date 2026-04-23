# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY build.mjs ./
COPY public ./public
RUN pnpm run build:full

FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3337 \
    DATA_DIR=/data

COPY package.json ./
COPY SKILL-ORBIT.md ./SKILL-ORBIT.md
COPY docs ./docs
COPY src ./src
COPY --from=build /app/dist/full ./dist/full

VOLUME ["/data"]
EXPOSE 3337

ENTRYPOINT ["node", "/app/src/cli/orbit.js"]
CMD ["serve", "--cwd", "/workspace"]
