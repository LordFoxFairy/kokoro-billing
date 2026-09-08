# Keep the runtime base reproducible; update this digest deliberately with the
# Node 24 Bookworm security-refresh process rather than floating on rebuild.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS package-manager
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM package-manager AS build
RUN pnpm install --frozen-lockfile --prod=false --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY prisma.config.ts ./
COPY database/generated ./database/generated
COPY src ./src
COPY scripts ./scripts
RUN pnpm prisma:generate && pnpm build

FROM package-manager AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV BILLING_HOST=0.0.0.0
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY package.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY database ./database
EXPOSE 4245
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4245/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
USER node
CMD ["node", "dist/src/main.js"]
