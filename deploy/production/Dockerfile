FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY worker ./worker
COPY .openai/hosting.json ./.openai/hosting.json
COPY index.html tsconfig.json vite.config.mjs ./
RUN npm run build

FROM node:24.12.0-bookworm-slim
WORKDIR /app
RUN mkdir -p /var/lib/ritm /var/backups/ritm && chown node:node /var/lib/ritm /var/backups/ritm
COPY --from=build /app/dist/client ./dist/client
COPY agent ./agent
COPY worker ./worker
USER node
ENV NODE_ENV=production RITM_DATA_DIR=/var/lib/ritm
HEALTHCHECK --interval=30s --timeout=8s --start-period=40s --retries=3 CMD ["node", "agent/healthcheck.js"]
CMD ["node", "agent/index.js"]
