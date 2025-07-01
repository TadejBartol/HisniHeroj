// =============================================================================
// Authentication Middleware
// =============================================================================

const jwt = require('jsonwebtoken');
const { queryOne } = require('../models/database');

/**
 * JWT Authentication Middleware
 */
async function authMiddleware(req, res, next) {
  try {
    console.log('🔐 AUTH MIDDLEWARE START');
    console.log('🔐 Headers:', req.headers.authorization);
    
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Potrebna je prijava'
        }
      });
    }

    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'Neveljaven token'
        }
      });
    }

    // Verify JWT token
    console.log('🔐 Verifying JWT token...');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('🔐 Token decoded:', decoded);
    
    // Get user from database
    console.log('🔐 Getting user from database...');
    const user = await queryOne(`
      SELECT 
        u.user_id, 
        u.email, 
        u.first_name, 
        u.last_name,
        u.is_active
      FROM users u 
      WHERE u.user_id = ? AND u.is_active = 1
    `, [decoded.userId]);
    console.log('🔐 User from DB:', user);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Uporabnik ni najden ali ni aktiven'
        }
      });
    }

    // Add user to request object
    req.user = {
      ...user,
      userId: user.user_id  // Add userId alias for backward compatibility
    };
    req.userId = user.user_id;
    
    console.log('🔐 AUTH MIDDLEWARE SUCCESS - calling next()');
    next();

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'Neveljaven token'
        }
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'TOKEN_EXPIRED',
          message: 'Token je potekel'
        }
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: 'Napaka pri preverjanju pristnosti'
      }
    });
  }
}

/**
 * Check if user has permission for household
 */
async function requireHouseholdAccess(req, res, next) {
  try {
    const householdId = req.params.household_id || req.params.householdId || req.params.id || req.body.household_id || req.query.household_id;
    
    if (!householdId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ID_REQUIRED',
          message: 'ID gospodinjstva je obvezen'
        }
      });
    }

    // Check if user is member of household
    const membership = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role,
        hm.can_create_tasks,
        hm.can_assign_tasks,
        hm.can_create_rewards,
        h.household_id,
        h.name as household_name
      FROM household_members hm
      JOIN households h ON hm.household_id = h.household_id
      WHERE hm.household_id = ? 
        AND hm.user_id = ? 
        AND hm.is_active = 1
    `, [householdId, req.userId]);

    if (!membership) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega gospodinjstva'
        }
      });
    }

    // Add household info to request
    req.household = {
      household_id: membership.household_id,
      name: membership.household_name,
      role: membership.role,
      permissions: {
        can_create_tasks: membership.can_create_tasks,
        can_assign_tasks: membership.can_assign_tasks,
        can_create_rewards: membership.can_create_rewards
      }
    };
    
    next();

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'HOUSEHOLD_ACCESS_ERROR',
        message: 'Napaka pri preverjanju dostopa do gospodinjstva'
      }
    });
  }
}

/**
 * Require specific permission
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.household) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_CONTEXT_REQUIRED',
          message: 'Potreben je kontekst gospodinjstva'
        }
      });
    }

    const hasPermission = req.household.role === 'owner' || 
                         req.household.role === 'admin' || 
                         req.household.permissions[permission];

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Nimate dovoljenj za to dejanje'
        }
      });
    }

    next();
  };
}

/**
 * Require admin or owner role
 */
function requireAdminAccess(req, res, next) {
  if (!req.household) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'HOUSEHOLD_CONTEXT_REQUIRED',
        message: 'Potreben je kontekst gospodinjstva'
      }
    });
  }

  if (req.household.role !== 'owner' && req.household.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'ADMIN_ACCESS_REQUIRED',
        message: 'Potrebne so administratorske pravice'
      }
    });
  }

  next();
}

module.exports = {
  authenticate: authMiddleware,
  authMiddleware,
  requireHouseholdAccess,
  requirePermission,
  requireAdminAccess
}; 