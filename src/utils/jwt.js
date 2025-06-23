// =============================================================================
// JWT Utility Functions
// =============================================================================

const jwt = require('jsonwebtoken');

/**
 * Generate JWT token for user
 */
function generateToken(userId, options = {}) {
  const payload = {
    userId,
    timestamp: Date.now()
  };

  const defaultOptions = {
    expiresIn: '7d',
    issuer: 'hisniheroj-api'
  };

  return jwt.sign(payload, process.env.JWT_SECRET, { ...defaultOptions, ...options });
}

/**
 * Generate refresh token
 */
function generateRefreshToken(userId) {
  return generateToken(userId, { expiresIn: '30d' });
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    throw error;
  }
}

/**
 * Decode token without verification (for debugging)
 */
function decodeToken(token) {
  return jwt.decode(token);
}

module.exports = {
  generateToken,
  generateRefreshToken,
  verifyToken,
  decodeToken
}; 