// =============================================================================
// HisniHeroj Family Tasks Manager - Main Server
// =============================================================================

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const path = require('path');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const householdRoutes = require('./routes/households');
const taskRoutes = require('./routes/tasks');
const assignmentRoutes = require('./routes/assignments');
const completionRoutes = require('./routes/completions');
const rewardRoutes = require('./routes/rewards');
const dashboardRoutes = require('./routes/dashboard');
const imageRoutes = require('./routes/images');

// Import middleware
console.log('DEBUG: About to import auth middleware...');
const authModule = require('./middleware/auth');
console.log('DEBUG: Auth module imported:', Object.keys(authModule));
console.log('DEBUG: Auth module authenticate type:', typeof authModule.authenticate);
const { authenticate } = authModule;
console.log('DEBUG: Destructured authenticate type:', typeof authenticate);

const { errorHandler, notFoundHandler } = require('./middleware/validation');

// Import database
const { testConnection, runScheduledTasks } = require('./models/database');

// =============================================================================
// DEBUG: Check all imports
// =============================================================================
console.log('=== DEBUG: Checking imports ===');
console.log('authRoutes:', typeof authRoutes, authRoutes ? '✅' : '❌');
console.log('userRoutes:', typeof userRoutes, userRoutes ? '✅' : '❌');
console.log('householdRoutes:', typeof householdRoutes, householdRoutes ? '✅' : '❌');
console.log('taskRoutes:', typeof taskRoutes, taskRoutes ? '✅' : '❌');
console.log('assignmentRoutes:', typeof assignmentRoutes, assignmentRoutes ? '✅' : '❌');
console.log('completionRoutes:', typeof completionRoutes, completionRoutes ? '✅' : '❌');
console.log('rewardRoutes:', typeof rewardRoutes, rewardRoutes ? '✅' : '❌');
console.log('dashboardRoutes:', typeof dashboardRoutes, dashboardRoutes ? '✅' : '❌');
console.log('imageRoutes:', typeof imageRoutes, imageRoutes ? '✅' : '❌');
console.log('authenticate:', typeof authenticate, authenticate ? '✅' : '❌');
console.log('errorHandler:', typeof errorHandler, errorHandler ? '✅' : '❌');
console.log('notFoundHandler:', typeof notFoundHandler, notFoundHandler ? '✅' : '❌');
console.log('=== END DEBUG ===');

// =============================================================================
// CONFIGURATION
// =============================================================================

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Winston logger
const logger = winston.createLogger({
  level: process.env.DEBUG === 'true' ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow file uploads
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Compression middleware
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Preveč zahtev. Poskusi ponovno čez nekaj minut.'
    }
  }
});

app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// =============================================================================
// ROUTES
// =============================================================================

// Health check (no auth required)
app.get('/api/v1/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      uptime: process.uptime()
    }
  });
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', authenticate, userRoutes);
app.use('/api/v1/households', authenticate, householdRoutes);
app.use('/api/v1/tasks', authenticate, taskRoutes);
app.use('/api/v1/assignments', authenticate, assignmentRoutes);
app.use('/api/v1/completions', authenticate, completionRoutes);
app.use('/api/v1/rewards', authenticate, rewardRoutes);
app.use('/api/v1/dashboard', authenticate, dashboardRoutes);
app.use('/api/v1/images', imageRoutes); // Some image routes don't need auth

// Serve static files for images
app.use('/api/v1/images/serve', express.static(process.env.UPLOAD_DIR || '/share/hisniheroj/uploads'));

// =============================================================================
// ERROR HANDLING
// =============================================================================

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// =============================================================================
// SERVER STARTUP
// =============================================================================

async function startServer() {
  try {
    // Test database connection
    logger.info('Testing database connection...');
    await testConnection();
    logger.info('Database connection successful!');

    // Start scheduled tasks (for recurring task assignments)
    logger.info('Starting scheduled tasks...');
    runScheduledTasks();

    // Start server
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 HisniHeroj API Server running on port ${PORT}`);
      logger.info(`📊 Health check: http://localhost:${PORT}/api/v1/health`);
      logger.info(`🔗 Base URL: http://localhost:${PORT}/api/v1`);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer(); 