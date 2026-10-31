# syntax=docker/dockerfile:1
# Website Testing Agent: one image serves the Angular UI and the agent API.
#
# Stage 1 builds the static frontend with the Angular CLI and prunes the
# dependency tree to what the server needs at runtime (express, playwright).
# Stage 2 is Playwright's own image, which already contains Chromium with every
# system library it needs, plus Node. The Playwright npm version in
# package.json must match the image tag (both 1.64.0).

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY angular.json tsconfig.json tsconfig.app.json ./
COPY public ./public
COPY src ./src
RUN pnpm build
# Keep only production dependencies for the runtime stage.
RUN pnpm prune --prod

FROM mcr.microsoft.com/playwright:v1.64.0-noble AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# python3 lets the server syntax-check generated tests (py_compile).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /app/package.json ./
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --chown=pwuser:pwuser server ./server
# Playwright's image ships an unprivileged user; never run the agent as root.
USER pwuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/index.js"]
