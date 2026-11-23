# One image for all three services (like the teacher's apiNode Dockerfile, plus a build
# step for TypeScript). Each ECS service picks its program with its own command:
#   billing API   node dist/index.js          (the default below)
#   MCP server    node dist/mcp/http.js
#   AI agent      node dist/agent/server.js
#
#   docker build -t billing-assistant .
#   docker build --target tools -t billing-assistant-tools .   (one-off migrate + seed)

# ---- build: compile src/ to dist/ (needs the dev dependencies: TypeScript) ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- tools: the one-off database job (migrations + demo data), run as an ECS task ----
# Kept out of the service image: the seed script and tsx are not needed to serve requests.
FROM build AS tools
COPY migrations ./migrations
COPY scripts ./scripts
COPY certs ./certs
ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-eu-north-1-bundle.pem
USER node
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && npx tsx scripts/seed.ts --allow-remote"]

# ---- runtime: what the services run (production dependencies only) ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# NODE_EXTRA_CA_CERTS: Node doesn't ship the Amazon RDS certificate authority; with it,
# the TLS connection to RDS is verified (POSTGRES_SSL=true, rejectUnauthorized).
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-eu-north-1-bundle.pem
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docs/Mobile_Provider_Billing_Guide.md ./docs/
COPY certs ./certs
# Don't run as root inside the container.
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
