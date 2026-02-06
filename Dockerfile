FROM node:20-alpine

WORKDIR /app

# Install git (required for contribution history, diffs, and commits)
RUN apk add --no-cache git

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source files
COPY . .

# Create canvas directory
RUN mkdir -p canvas

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/stats || exit 1

# Start server
CMD ["node", "server/index.js"]
