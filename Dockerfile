# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# proxy.ts now lives in src/ (Next.js ignores a root-level proxy.ts when the
# app uses src/app), so it is already covered by the `src` copy above.
COPY next.config.ts tsconfig.json postcss.config.mjs ./
# The homepage is statically generated and NEXT_PUBLIC_* values are inlined at
# build time, so the public origin must be supplied as a build argument:
#   docker build --build-arg NEXT_PUBLIC_SITE_URL=https://dns.example.com .
# The default matches the container port so the homepage shows a working URL
# for a local `docker run -p 8367:8367`.
ARG NEXT_PUBLIC_SITE_URL="http://localhost:8367"
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=320
ENV PORT=8367
ENV HOSTNAME=0.0.0.0

# The official node image already ships an unprivileged `node` user (uid 1000).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 8367
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${PORT}/" || exit 1
CMD ["node", "server.js"]
