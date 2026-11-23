# syntax=docker/dockerfile:1

# ---- Stage 1: bundle @agentfleet/hub into a single ESM file -----------------
FROM node:24-alpine AS builder
WORKDIR /src

RUN npm install -g pnpm@12.21.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/proto/package.json packages/proto/package.json
COPY packages/hub/package.json packages/hub/package.json

RUN pnpm install --frozen-lockfile --filter @agentfleet/hub...

COPY packages/proto packages/proto
COPY packages/hub packages/hub

RUN pnpm --filter @agentfleet/hub build

# ---- Stage 2: minimal non-root runtime --------------------------------------
FROM node:24-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/Bigheadh/agentfleet"
LABEL org.opencontainers.image.description="AgentFleet Hub — self-hosted control plane for coding agents"
LABEL org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

COPY --from=builder /src/packages/hub/dist/agentfleet-hub.mjs /app/agentfleet-hub.mjs
RUN printf '#!/bin/sh\nexec node /app/agentfleet-hub.mjs "$@"\n' > /usr/local/bin/agentfleet-hub \
  && chmod +x /usr/local/bin/agentfleet-hub \
  && mkdir -p /data \
  && chown -R node:node /app /data

ENV NODE_ENV=production \
    AGENTFLEET_PORT=8787 \
    AGENTFLEET_HUB_DATA=/data

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AGENTFLEET_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["agentfleet-hub"]
CMD ["start"]
