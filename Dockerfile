# ---------------------------------------------------------------------------
# Lantern Journal — production container image
# Multi-stage build on Node 20, listens on 8080 (Cloud Run's expected port).
# ---------------------------------------------------------------------------
FROM node:20-slim AS base
WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the application source
COPY . .

# Cloud Run injects PORT; default to 8080 for local `docker run`
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

# Run as the non-root "node" user provided by the base image
USER node

CMD ["node", "server.js"]
