# Tiny Snitch. Build:  docker build -t tiny-snitch .   Run: see compose.yaml (it publishes the port to 127.0.0.1 only).
# Node 22.13+ is required (the database uses node:sqlite).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    APP_HOST=0.0.0.0 \
    APP_PORT=3000 \
    DATABASE_URL=file:/app/data/tiny-snitch.db \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# The CML MCP bridge is installed in the image, not fetched with `npx -y` at start-up, so a start does not depend on
# the npm registry. Pin MCP_REMOTE_VERSION to a version you have tested. Use it with CML_MCP_COMMAND=mcp-remote.
ARG MCP_REMOTE_VERSION=latest
RUN npm install -g mcp-remote@${MCP_REMOTE_VERSION} && npm cache clean --force

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json next.config.mjs ./
COPY scripts/run-next.mjs ./scripts/run-next.mjs

# Run as the unprivileged "node" user; only the data directory is writable.
RUN mkdir -p /app/data && chown -R node:node /app/data /app/.next
USER node
VOLUME ["/app/data"]
EXPOSE 3000

# Any answer below 500 means the server is up. Before the first administrator exists /api/status answers 401, which is healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3000)+'/api/status').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/run-next.mjs", "start"]
