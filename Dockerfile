# syntax=docker/dockerfile:1

FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3337 \
    DATA_DIR=/data

COPY package.json ./
COPY SKILL-ORBIT.md ./SKILL-ORBIT.md
COPY docs ./docs
COPY src ./src
COPY dist/full ./dist/full

VOLUME ["/data"]
EXPOSE 3337

ENTRYPOINT ["node", "/app/src/cli/orbit.js"]
CMD ["serve", "--cwd", "/workspace"]
