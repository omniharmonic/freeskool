# Free School production images. Two targets from one workspace layer:
#   appview — the AppView (indexer + API + jobs), run with tsx as the unprivileged `node` user
#   web     — Caddy serving the built PWA and terminating TLS for the whole stack
# See infra/production/compose.yml and docs/deployment.md.
FROM node:22-bookworm-slim AS workspace
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY infra/seed ./infra/seed
RUN pnpm install --frozen-lockfile

FROM workspace AS web-build
RUN pnpm --filter @freeschool/web build

FROM caddy:2-alpine AS web
COPY --from=web-build /app/apps/web/dist /srv
COPY infra/production/Caddyfile /etc/caddy/Caddyfile

FROM workspace AS appview
ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["pnpm", "--filter", "@freeschool/appview", "exec", "tsx", "src/index.ts"]
