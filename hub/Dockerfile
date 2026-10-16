# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-slim AS server
WORKDIR /server
COPY server/package.json server/package-lock.json ./
# better-sqlite3 ships prebuilt binaries, so no native toolchain is needed
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --ignore-scripts
COPY server/ ./
RUN npm run build && npm prune --omit=dev --ignore-scripts \
 && cd node_modules/better-sqlite3 && rm -rf deps src \
 && find prebuilds -name '*.node' ! -name "linux-$(node -p 'process.arch').node" -delete

FROM node:22-slim
ARG VERSION=0.1.0
ENV NODE_ENV=production \
    BESIGOR_VERSION=${VERSION} \
    DATA_DIR=/data \
    WEB_DIR=/app/web \
    PORT=8090
WORKDIR /app
COPY --from=server /server/node_modules ./node_modules
COPY --from=server /server/dist ./dist
COPY --from=server /server/package.json ./
COPY --from=web /web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
