FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build:web

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/remindme.sqlite
ENV PORT=8080
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/healthz || exit 1

CMD ["npx", "tsx", "--tsconfig", "tsconfig.node.json", "src/node.ts"]
