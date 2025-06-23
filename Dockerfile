ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js and npm
RUN apk add --no-cache \
    nodejs \
    npm \
    python3 \
    make \
    g++

# Set working directory
WORKDIR /app

# Copy package.json first for better caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --only=production

# Copy source code
COPY src/ ./src/
COPY run.sh ./

# Make run script executable
RUN chmod +x run.sh

# Create uploads directory
RUN mkdir -p /share/hisniheroj/uploads

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/v1/health || exit 1

# Start the application
CMD ["./run.sh"] 