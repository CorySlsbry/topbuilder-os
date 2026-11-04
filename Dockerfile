# syntax=docker/dockerfile:1
# Multi-stage build → minimal, NON-ROOT Next.js standalone image for Cloud Run.
# Deployed by immutable @sha256 digest (never :latest) — see cloudbuild.yaml.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm EXPLICITLY. Two traps here, both hit on 2026-07-25:
#   1. Bare `corepack enable` fetches the LATEST pnpm at build time. pnpm 11
#      stopped reading `pnpm.overrides` from package.json, so the image computed
#      "no overrides" while the lockfile recorded the CVE pins, and
#      --frozen-lockfile correctly refused. A local check cannot reproduce it.
#   2. `corepack prepare --activate` (no version) reads package.json, which does
#      not exist yet in this stage — it is copied in `deps`. Name the version.
# Keep this in step with package.json's packageManager field.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# --- deps: install with a cached, frozen lockfile ---------------------------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- builder: compile the standalone server ---------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* build args (if any) would be passed here as --build-arg before
# `next build`. There are none yet; runtime secrets are read at runtime.
RUN pnpm build

# --- runner: distroless-style minimal runtime, non-root ---------------------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080

# Create an unprivileged user and own the app dir.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone output ships only what the server needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
