# ---------------------------------------------------------------------------
# Vera — single multi-stage Dockerfile for all services.
#
# Build:  docker build --build-arg SERVICE=pay -t vera-pay .
# Run:    docker run -p 3003:3003 --env-file .env vera-pay
#
# SERVICE must be one of:
#   tap, activation, pay, vault, admin, data-prep, rca, batch-processor,
#   card-ops
# ---------------------------------------------------------------------------

# --- Stage 1: install + compile everything -----------------------------------
FROM node:22-alpine AS builder

# OpenSSL is needed so `prisma generate` detects the correct engine
# binary (linux-musl-openssl-3.0.x) instead of defaulting to 1.1.x.
RUN apk add --no-cache openssl

WORKDIR /app

# Copy workspace root files first (for npm ci cache efficiency)
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./

# Copy all package.json files so `npm ci` can resolve the workspace graph
COPY packages/core/package.json              packages/core/
COPY packages/db/package.json                packages/db/
COPY packages/webauthn/package.json          packages/webauthn/
COPY packages/handoff/package.json           packages/handoff/
COPY packages/vault-client/package.json      packages/vault-client/
COPY packages/programs/package.json          packages/programs/
COPY packages/service-auth/package.json      packages/service-auth/
COPY packages/retention/package.json         packages/retention/
COPY packages/emv/package.json              packages/emv/
COPY packages/provisioning-client/package.json packages/provisioning-client/
COPY packages/cognito-auth/package.json     packages/cognito-auth/
COPY packages/admin-config/package.json     packages/admin-config/
COPY services/tap/package.json               services/tap/
COPY services/activation/package.json        services/activation/
COPY services/pay/package.json               services/pay/
COPY services/vault/package.json             services/vault/
COPY services/admin/package.json             services/admin/
COPY services/data-prep/package.json        services/data-prep/
COPY services/rca/package.json              services/rca/
COPY services/card-ops/package.json         services/card-ops/
COPY services/batch-processor/package.json  services/batch-processor/
COPY services/activation/frontend/package.json services/activation/frontend/
COPY services/pay/frontend/package.json      services/pay/frontend/
COPY services/admin/frontend/package.json    services/admin/frontend/

RUN npm ci

# Copy source code (after npm ci to leverage Docker layer cache)
COPY packages/ packages/
COPY services/ services/
COPY scripts/  scripts/

# Generate Prisma client
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

# Compile all TypeScript (backend — project references)
RUN npx tsc -b

# Rewrite package exports from ./src/index.ts → ./dist/index.js so `node`
# (not tsx) can resolve workspace packages at runtime.
RUN node scripts/fix-exports.mjs

# Build frontends (Vite).  Ensure the directory always exists so the COPY
# in the runner stage never fails for services without a frontend.
ARG SERVICE
RUN if [ -d "services/${SERVICE}/frontend/src" ]; then \
      npm run build -w "@vera/${SERVICE}-frontend"; \
    else \
      mkdir -p "services/${SERVICE}/frontend/dist"; \
    fi

# Ensure a cap-files directory exists for every service so the COPY in
# the runner stage resolves uniformly.  Only card-ops actually populates
# it (via the checked-in cap-files/ at build context root).
RUN mkdir -p "services/${SERVICE}/cap-files"

# --- Stage 2: production image (only what the target SERVICE needs) ----------
FROM node:22-alpine AS runner

RUN apk add --no-cache tini openssl
WORKDIR /app

# Copy the whole workspace — npm workspaces resolves via symlinks in
# node_modules, so we can't cherry-pick without breaking resolution.
# The .dockerignore already strips git, tests, .env files, etc.
COPY --from=builder /app/package.json          ./
COPY --from=builder /app/node_modules/         node_modules/

# Copy all compiled packages (dist/ + package.json)
COPY --from=builder /app/packages/core/dist/          packages/core/dist/
COPY --from=builder /app/packages/core/package.json   packages/core/
COPY --from=builder /app/packages/db/dist/            packages/db/dist/
COPY --from=builder /app/packages/db/package.json     packages/db/
COPY --from=builder /app/packages/db/prisma/          packages/db/prisma/
COPY --from=builder /app/packages/webauthn/dist/       packages/webauthn/dist/
COPY --from=builder /app/packages/webauthn/package.json packages/webauthn/
COPY --from=builder /app/packages/handoff/dist/        packages/handoff/dist/
COPY --from=builder /app/packages/handoff/package.json packages/handoff/
COPY --from=builder /app/packages/vault-client/dist/   packages/vault-client/dist/
COPY --from=builder /app/packages/vault-client/package.json packages/vault-client/
COPY --from=builder /app/packages/programs/dist/       packages/programs/dist/
COPY --from=builder /app/packages/programs/package.json packages/programs/
COPY --from=builder /app/packages/service-auth/dist/   packages/service-auth/dist/
COPY --from=builder /app/packages/service-auth/package.json packages/service-auth/
COPY --from=builder /app/packages/retention/dist/      packages/retention/dist/
COPY --from=builder /app/packages/retention/package.json packages/retention/
COPY --from=builder /app/packages/emv/dist/            packages/emv/dist/
COPY --from=builder /app/packages/emv/package.json     packages/emv/
COPY --from=builder /app/packages/provisioning-client/dist/ packages/provisioning-client/dist/
COPY --from=builder /app/packages/provisioning-client/package.json packages/provisioning-client/
COPY --from=builder /app/packages/cognito-auth/dist/   packages/cognito-auth/dist/
COPY --from=builder /app/packages/cognito-auth/package.json packages/cognito-auth/
COPY --from=builder /app/packages/admin-config/dist/   packages/admin-config/dist/
COPY --from=builder /app/packages/admin-config/package.json packages/admin-config/

# Copy the target service's compiled output
ARG SERVICE
COPY --from=builder /app/services/${SERVICE}/dist/          services/${SERVICE}/dist/
COPY --from=builder /app/services/${SERVICE}/package.json   services/${SERVICE}/

# Copy built frontend (may be empty for tap/vault — builder ensures dir exists)
COPY --from=builder /app/services/${SERVICE}/frontend/dist/ services/${SERVICE}/frontend/dist/

# card-ops: ship the CAP files the admin operations deploy to cards.
# The builder stage ensures the directory always exists (empty for
# non-card-ops services, populated for card-ops), so this COPY is safe
# to run unconditionally.
COPY --from=builder /app/services/${SERVICE}/cap-files/ services/${SERVICE}/cap-files/

# Copy scripts/ so one-off tasks (seed, regen-sad-e2e, etc.) can run via
# `ecs run-task` with a command override.  Not used by the normal service
# process; kept in every image so any of them doubles as a one-off shell.
COPY --from=builder /app/scripts/ scripts/
COPY --from=builder /app/tsconfig.json /app/tsconfig.base.json ./

# Bake the service name into an ENV so CMD can reference it at runtime
# (ARG is build-time only).
ENV SERVICE_NAME=${SERVICE}

# Non-root user for production
RUN addgroup -S vera && adduser -S vera -G vera \
    && chown -R vera:vera node_modules/.prisma node_modules/@prisma
USER vera

ENV NODE_ENV=production

# tini handles PID 1 correctly (signal forwarding, zombie reaping)
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "node services/${SERVICE_NAME}/dist/index.js"]
