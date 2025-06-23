// =============================================================================
// Authentication Routes
// =============================================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, queryOne, beginTransaction, commitTransaction, rollbackTransaction } = require('../models/database');
const { generateToken, generateRefreshToken, verifyToken } = require('../utils/jwt');
const { validate, authSchemas } = require('../middleware/validation');

const router = express.Router();

// =============================================================================
// POST /auth/register - User Registration
// =============================================================================

router.post('/register', validate(authSchemas.register), async (req, res) => {
  let connection;
  
  try {
    const { email, password, first_name, last_name } = req.body;

    // Check if user already exists
    const existingUser = await queryOne(
      'SELECT user_id FROM users WHERE email = ?',
      [email]
    );

    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'USER_ALREADY_EXISTS',
          message: 'Uporabnik s tem email naslovom že obstaja'
        }
      });
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Begin transaction
    connection = await beginTransaction();

    // Create user
    const userResult = await connection.execute(`
      INSERT INTO users (email, password_hash, first_name, last_name, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `, [email, passwordHash, first_name, last_name]);

    const userId = userResult[0].insertId;

    // Commit transaction
    await commitTransaction(connection);

    // Generate tokens
    const token = generateToken(userId);
    const refreshToken = generateRefreshToken(userId);

    // Update last login
    await query(
      'UPDATE users SET last_login = NOW() WHERE user_id = ?',
      [userId]
    );

    res.status(201).json({
      success: true,
      data: {
        user: {
          user_id: userId,
          email,
          first_name,
          last_name,
          created_at: new Date().toISOString()
        },
        token,
        refresh_token: refreshToken,
        first_time_user: true
      }
    });

  } catch (error) {
    if (connection) {
      await rollbackTransaction(connection);
    }
    
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'REGISTRATION_ERROR',
        message: 'Napaka pri registraciji'
      }
    });
  }
});

// =============================================================================
// POST /auth/login - User Login
// =============================================================================

router.post('/login', validate(authSchemas.login), async (req, res) => {
  try {
    const { email, password } = req.body;

    // Get user with password hash
    const user = await queryOne(`
      SELECT 
        u.user_id,
        u.email,
        u.password_hash,
        u.first_name,
        u.last_name,
        u.is_active
      FROM users u 
      WHERE u.email = ?
    `, [email]);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Napačen email ali geslo'
        }
      });
    }

    if (!user.is_active) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'USER_INACTIVE',
          message: 'Uporabniški račun ni aktiven'
        }
      });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Napačen email ali geslo'
        }
      });
    }

    // Get user's current household (if any)
    const currentHousehold = await queryOne(`
      SELECT 
        h.household_id,
        h.name,
        hm.role
      FROM household_members hm
      JOIN households h ON hm.household_id = h.household_id
      WHERE hm.user_id = ? AND hm.is_active = 1 AND h.is_active = 1
      ORDER BY hm.joined_at DESC
      LIMIT 1
    `, [user.user_id]);

    // Generate tokens
    const token = generateToken(user.user_id);
    const refreshToken = generateRefreshToken(user.user_id);

    // Update last login
    await query(
      'UPDATE users SET last_login = NOW() WHERE user_id = ?',
      [user.user_id]
    );

    res.json({
      success: true,
      data: {
        user: {
          user_id: user.user_id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          current_household: currentHousehold || null
        },
        token,
        refresh_token: refreshToken
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'LOGIN_ERROR',
        message: 'Napaka pri prijavi'
      }
    });
  }
});

// =============================================================================
// POST /auth/refresh - Refresh Token
// =============================================================================

router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'REFRESH_TOKEN_REQUIRED',
          message: 'Refresh token je obvezen'
        }
      });
    }

    // Verify refresh token
    const decoded = verifyToken(refresh_token);
    
    // Check if user still exists and is active
    const user = await queryOne(
      'SELECT user_id FROM users WHERE user_id = ? AND is_active = 1',
      [decoded.userId]
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Uporabnik ni najden'
        }
      });
    }

    // Generate new tokens
    const newToken = generateToken(decoded.userId);
    const newRefreshToken = generateRefreshToken(decoded.userId);

    res.json({
      success: true,
      data: {
        token: newToken,
        refresh_token: newRefreshToken,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      }
    });

  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_REFRESH_TOKEN',
          message: 'Neveljaven refresh token'
        }
      });
    }

    console.error('Token refresh error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'TOKEN_REFRESH_ERROR',
        message: 'Napaka pri osveževanju token-a'
      }
    });
  }
});

// =============================================================================
// POST /auth/logout - User Logout
// =============================================================================

router.post('/logout', async (req, res) => {
  // For stateless JWT, logout is handled client-side
  // Could implement token blacklisting here if needed
  
  res.json({
    success: true,
    data: {
      message: 'Uspešna odjava'
    }
  });
});

// =============================================================================
// GET /auth/me - Get Current User (requires token)
// =============================================================================

router.get('/me', async (req, res) => {
  try {
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
    const decoded = verifyToken(token);

    const user = await queryOne(`
      SELECT 
        u.user_id,
        u.email,
        u.first_name,
        u.last_name,
        u.profile_image,
        u.created_at,
        u.last_login
      FROM users u
      WHERE u.user_id = ? AND u.is_active = 1
    `, [decoded.userId]);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Uporabnik ni najden'
        }
      });
    }

    res.json({
      success: true,
      data: {
        user
      }
    });

  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'Neveljaven token'
        }
      });
    }

    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_USER_ERROR',
        message: 'Napaka pri pridobivanju uporabnika'
      }
    });
  }
});

module.exports = router; 