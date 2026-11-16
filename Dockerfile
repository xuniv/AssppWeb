# Build the browser tools on the builder's native architecture.
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend-deps
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund \
    && cp node_modules/@esbuild/linux-$(node -p process.arch)/bin/esbuild /tmp/esbuild

# Go and extraction tools never enter the production image. The output contains
# a client interpreter and immutable public Apple data; no account is used here.
FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine AS client-runtime
RUN apk add --no-cache bash git python3
WORKDIR /app
COPY runtime/ ./runtime/
COPY --from=frontend-deps /tmp/esbuild /usr/local/bin/esbuild
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/root/.cache/ipatool \
    ESBUILD=/usr/local/bin/esbuild bash runtime/build.sh /out

FROM frontend-deps AS frontend-build
COPY frontend/ ./
COPY --from=client-runtime /out ./public/store-runtime
RUN npm run build

FROM node:24-alpine AS backend-build
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/package.json ./
COPY --from=frontend-build /app/frontend/dist ./public
RUN mkdir -p /data/packages
EXPOSE 8080
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 BUILD_COMMIT=$BUILD_COMMIT BUILD_DATE=$BUILD_DATE
CMD ["node", "dist/index.js"]
