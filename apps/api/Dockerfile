FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://127.0.0.1:3000/health/live || exit 1
CMD ["node","src/server.js"]
