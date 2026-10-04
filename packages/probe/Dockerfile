# ghcr.io/fi-workers/mocco-probe: the @mocco/probe agent (ADR 0027) as a container, for
# Mocco's hosted regions and for private locations.
#
#   docker build -f packages/probe/Dockerfile -t mocco-probe .     # from the repository root
#   docker run --rm -e MOCCO_URL=https://www.mocco.work -e MOCCO_PROBE_TOKEN=mpl_… mocco-probe
#
# The build context is the repository root, trimmed by Dockerfile.dockerignore next to this file.

FROM node:22.22.0-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
# Only the probe and what it builds with; dependency lifecycle scripts stay off, as in CI.
ENV YARN_ENABLE_SCRIPTS=false
RUN yarn workspaces focus @mocco/probe && yarn workspace @mocco/probe build
# Then only what it runs with: zod and undici.
RUN rm -rf node_modules packages/*/node_modules && yarn workspaces focus --production @mocco/probe \
  && rm -rf node_modules/@mocco

FROM node:22.22.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/packages/probe/package.json ./package.json
COPY --from=build /repo/packages/probe/LICENSE ./LICENSE
COPY --from=build /repo/packages/probe/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
USER node
# SIGTERM stops leasing, finishes running checks and posts their results before exiting.
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/cli.js"]
