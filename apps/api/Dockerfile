FROM node:22-alpine AS deps
WORKDIR /app
COPY apps/api/package*.json ./
RUN npm install --omit=dev
FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/api/package*.json ./
COPY apps/api/src ./src
COPY agents/room-agent/package.json agents/room-agent/package-lock.json /tmp/room-agent-release/
COPY agents/room-agent/src /tmp/room-agent-release/src
RUN mkdir -p /app/releases && tar -czf /app/releases/room-agent.tar.gz -C /tmp/room-agent-release . && rm -rf /tmp/room-agent-release
COPY agents/room-agent/package.json /app/releases/room-agent-package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://127.0.0.1:3000/health/live || exit 1
CMD ["node","src/server.js"]
