# syntax=docker/dockerfile:1

FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=13701 \
    DATA_DIR=/data \
    ORBIT_USE_DIST=1

COPY package.json ./
COPY SKILL-ORBIT.md ./SKILL-ORBIT.md
COPY docs ./docs
COPY src ./src
COPY dist/full ./dist/full

VOLUME ["/data"]
EXPOSE 13701

ENTRYPOINT ["node", "/app/src/cli/orbit.js"]
CMD ["serve", "--cwd", "/workspace"]
