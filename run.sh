#!/usr/bin/with-contenv bashio
# ==============================================================================
# HisniHeroj Add-on Startup Script
# ==============================================================================

# Set variables from add-on configuration
export DATABASE_HOST=$(bashio::config 'database_host')
export DATABASE_PORT=$(bashio::config 'database_port')
export DATABASE_NAME=$(bashio::config 'database_name')
export DATABASE_USER=$(bashio::config 'database_user')
export DATABASE_PASSWORD=$(bashio::config 'database_password')
export JWT_SECRET=$(bashio::config 'jwt_secret')
export UPLOAD_MAX_SIZE=$(bashio::config 'upload_max_size')
export CORS_ORIGIN=$(bashio::config 'cors_origin')
export DEBUG=$(bashio::config 'debug')

# Set additional environment variables
export NODE_ENV=production
export PORT=3000
export UPLOAD_DIR="/share/hisniheroj/uploads"

# Create necessary directories
mkdir -p /share/hisniheroj/uploads/original
mkdir -p /share/hisniheroj/uploads/compressed
mkdir -p /share/hisniheroj/uploads/thumbnails

# Log startup information
bashio::log.info "Starting HisniHeroj Family Tasks Manager..."
bashio::log.info "Database: ${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}"
bashio::log.info "Upload directory: ${UPLOAD_DIR}"

# Check database connection
bashio::log.info "Testing database connection..."

# Wait for database to be ready
while ! nc -z "${DATABASE_HOST}" "${DATABASE_PORT}"; do
  bashio::log.info "Waiting for database to be available..."
  sleep 2
done

bashio::log.info "Database is available!"

# Start the Node.js application
bashio::log.info "Starting API server on port ${PORT}..."
exec node src/index.js 