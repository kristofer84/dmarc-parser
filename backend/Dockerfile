# Multi-stage build for production
FROM node:26-slim AS builder

WORKDIR /app

# Install OpenSSL and other dependencies needed for Prisma
RUN apt-get update && apt-get install -y \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src
COPY prisma ./prisma
# Prisma 7 reads the datasource URL from the config file, and db push runs at start.
COPY prisma.config.ts ./

# Generate Prisma client
RUN npx prisma generate

# Build the application
RUN npm run build

# Production stage
FROM node:26-slim AS production

WORKDIR /app

# Install OpenSSL, curl, and su-exec for Prisma and health checks
RUN apt-get update && apt-get install -y \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for Prisma CLI)
RUN npm ci && npm cache clean --force

# Copy built application
COPY --from=builder /app/dist ./dist
COPY prisma ./prisma
COPY prisma.config.ts ./

# Create data directory and ensure it's writable
RUN mkdir -p /app/data && chmod 777 /app/data

# Expose port
EXPOSE 8096

# The image declares 8096 above and health-checks it below, so it has to actually listen there
# when run on its own - `npm start` otherwise takes the development default (3000) and the
# published port and healthcheck both point at nothing. Compose passes these explicitly, so this
# only changes the standalone run.
ENV NODE_ENV=production \
    PORT=8096

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8096/health || exit 1

# Start the application
CMD ["npm", "start"]