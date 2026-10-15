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
# IPv4 only by default (Docker sets HOSTNAME to the container id, so it must be
# set explicitly). For dual-stack on an IPv6-enabled Docker network use
# `-e HOSTNAME=::`.
ENV HOSTNAME=0.0.0.0

# The official node image already ships an unprivileged `node` user (uid 1000).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# Records the TCP peer address for the rate limiter (client identity, the
# TRUSTED_PROXIES check and the fallback) and sets tight HTTP request/header
# timeouts for slow clients.
COPY --chown=node:node server/socket-ip-preload.cjs ./

USER node
EXPOSE 8367
# HEAD on the DoH route exercises the proxy and the route bundle (not just the
# prerendered homepage) without upstream traffic; HEAD is not rate limited.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/doh/dns-query',{method:'HEAD'}).then(r=>process.exit(r.status===204?0:1),()=>process.exit(1))"
CMD ["node", "--require", "./socket-ip-preload.cjs", "server.js"]
