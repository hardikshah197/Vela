# Stage 1: Build Go backend
FROM golang:1.22-bookworm AS go-builder
WORKDIR /build
COPY server/ ./server/
WORKDIR /build/server
RUN go mod download && go build -o /vela-server .

# Stage 2: Build frontend
FROM node:20-slim AS frontend-builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx vite build

# Stage 3: Runtime
FROM debian:bookworm-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git \
    procps \
    lsof \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Go binary
COPY --from=go-builder /vela-server ./vela-server

# Copy frontend build
COPY --from=frontend-builder /build/dist ./dist

EXPOSE 3001

ENV VELA_SEARCH_ROOTS=/workspace
ENV VELA_CLONE_DIR=/workspace/cloned
ENV SHELL=/bin/bash
ENV NODE_ENV=production

RUN mkdir -p /workspace/cloned

CMD ["./vela-server"]
