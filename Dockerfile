# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests and tsconfig
COPY package*.json tsconfig.json ./

# Copy Prisma schema
COPY prisma ./prisma

# Install all dependencies (including devDependencies)
RUN npm ci

# Copy source code
COPY src ./src

# Generate Prisma client and compile TypeScript to JavaScript
RUN npx prisma generate
RUN npm run build

# Stage 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy dependency manifests
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy Prisma schema and generate Client for production runtime
COPY prisma ./prisma
RUN npx prisma generate

# Copy the compiled build from the builder stage
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3000

# Start production server
CMD ["npm", "start"]
