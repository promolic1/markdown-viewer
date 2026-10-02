# Static web version (File System Access mode) for Cloud Run or any container
# host. Node is only used to assemble dist/; the final image is a single static
# binary on `scratch` plus ~1 MB of HTML/JS/CSS.
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY public ./public
COPY src/vendor.js ./src/vendor.js
COPY scripts ./scripts
RUN node scripts/build.js

FROM ghcr.io/static-web-server/static-web-server:2
COPY deploy/sws.toml /sws.toml
COPY --from=build /app/dist /public
ENV SERVER_CONFIG_FILE=/sws.toml
EXPOSE 8080
