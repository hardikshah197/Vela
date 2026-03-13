FROM node:20-slim

# Install build tools for node-pty and git for project resolution
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    git \
    procps \
    lsof \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install all dependencies (devDependencies needed for vite build)
RUN npm ci

# Copy source
COPY . .

# Build frontend
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

# Expose backend port
EXPOSE 3001

# Environment defaults
ENV VELA_SEARCH_ROOTS=/workspace
ENV VELA_CLONE_DIR=/workspace/cloned
ENV SHELL=/bin/bash
ENV NODE_ENV=production

# Create workspace directories
RUN mkdir -p /workspace/cloned

# Start both backend and static file server
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
