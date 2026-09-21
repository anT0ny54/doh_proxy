FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY src ./src
COPY next.config.ts proxy.ts tsconfig.json eslint.config.mjs postcss.config.mjs ./
# The homepage is statically generated and NEXT_PUBLIC_* values are inlined at
# build time, so the public origin must be supplied as a build argument:
#   docker build --build-arg NEXT_PUBLIC_SITE_URL=https://dns.example.com .
# The default matches the container port so the homepage shows a working URL
# for a local `docker run -p 8367:8367`.
ARG NEXT_PUBLIC_SITE_URL="http://localhost:8367"
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8367
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 8367
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8367/ || exit 1
CMD ["node", "server.js"]
