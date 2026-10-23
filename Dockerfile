# syntax=docker/dockerfile:1
#
# csip-ocpp-bridge image. Small (Alpine), runs as the non-root `node` user,
# and runs compiled JavaScript with plain `node`: no TypeScript, tsx or
# esbuild in the final image. Same base image as Open Dynamic Export's.
#
#   docker build -t csip-ocpp-bridge .
#   docker run -v ./config.json:/config/config.json:ro -p 9000:9000 csip-ocpp-bridge

# ---- build: compile src/ to dist/ ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: nothing we need runs an install script, and skipping them
# means a compromised dependency can't run code at build time.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- run ----
FROM node:24-alpine
ENV NODE_ENV=production \
    BRIDGE_CONFIG=/config/config.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# A reference copy; the real config is mounted at /config/config.json.
COPY config.example.json ./

USER node
# OCPP: chargers connect to ws://<host>:9000/<charger id>. Must match ocpp.port.
EXPOSE 9000
# `node` directly (not `npm start`), so SIGTERM from `docker stop` reaches
# the bridge and it shuts down cleanly. compose's `init: true` reaps zombies.
CMD ["node", "dist/main.js"]
