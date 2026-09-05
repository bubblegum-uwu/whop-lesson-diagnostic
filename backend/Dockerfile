# syntax=docker/dockerfile:1

# ---- Build stage: compile TypeScript -> dist/ ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ffmpeg is installed via apt so we get a real, correctly-linked binary for
# this exact base image — no static-binary/glibc compatibility guesswork.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Cloud Run injects PORT; the app reads it via config.ts (default 8080).
EXPOSE 8080

USER node
CMD ["node", "dist/server.js"]
