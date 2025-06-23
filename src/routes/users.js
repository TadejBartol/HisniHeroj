// =============================================================================
// User Management Routes
// =============================================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, queryOne } = require('../models/database');
const { validate, userSchemas } = require('../middleware/validation');
const { uploadSingle } = require('../utils/upload');

const router = express.Router();

// =============================================================================
// GET /users/profile - Get User Profile
// =============================================================================

router.get('/profile', async (req, res) => {
  try {
    const user = await queryOne(`
      SELECT 
        u.user_id,
        u.email,
        u.first_name,
        u.last_name,
        u.profile_image,
        u.created_at,
        u.last_login,
        -- Current household info
        h.household_id,
        h.name as household_name,
        hm.role as household_role,
        -- Point totals
        COALESCE(SUM(tc.points_earned), 0) as total_points_earned,
        COALESCE(SUM(rc.points_spent), 0) as total_points_spent,
        COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc.points_spent), 0) as current_points
      FROM users u
      LEFT JOIN household_members hm ON u.user_id = hm.user_id AND hm.is_active = 1
      LEFT JOIN households h ON hm.household_id = h.household_id AND h.is_active = 1
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by_user_id
      LEFT JOIN reward_claims rc ON u.user_id = rc.claimed_by_user_id AND rc.is_fulfilled = 1
      WHERE u.user_id = ? AND u.is_active = 1
      GROUP BY u.user_id, h.household_id
    `, [req.user.userId]);

    if (!user) {
      return res.status(404).json({
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
    console.error('Get user profile error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_PROFILE_ERROR',
        message: 'Napaka pri pridobivanju profila'
      }
    });
  }
});

// =============================================================================
// PUT /users/profile - Update User Profile
// =============================================================================

router.put('/profile', validate(userSchemas.updateProfile), async (req, res) => {
  try {
    const { first_name, last_name } = req.body;

    // Update user profile
    await query(`
      UPDATE users 
      SET 
        first_name = ?,
        last_name = ?,
        updated_at = NOW()
      WHERE user_id = ?
    `, [first_name, last_name, req.user.userId]);

    // Fetch updated user data
    const updatedUser = await queryOne(`
      SELECT 
        user_id,
        email,
        first_name,
        last_name,
        profile_image,
        created_at,
        updated_at
      FROM users 
      WHERE user_id = ?
    `, [req.user.userId]);

    res.json({
      success: true,
      data: {
        user: updatedUser,
        message: 'Profil je bil uspešno posodobljen'
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'UPDATE_PROFILE_ERROR',
        message: 'Napaka pri posodabljanju profila'
      }
    });
  }
});

// =============================================================================
// POST /users/profile/image - Upload Profile Image
// =============================================================================

router.post('/profile/image', uploadSingle('profile_image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'IMAGE_REQUIRED',
          message: 'Slika je obvezna'
        }
      });
    }

    // Update user with new profile image
    await query(`
      UPDATE users 
      SET 
        profile_image = ?,
        updated_at = NOW()
      WHERE user_id = ?
    `, [req.file.filename, req.user.userId]);

    res.json({
      success: true,
      data: {
        profile_image: req.file.filename,
        image_url: `/api/images/${req.file.filename}`,
        message: 'Profilna slika je bila uspešno posodobljena'
      }
    });

  } catch (error) {
    console.error('Upload profile image error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'UPLOAD_IMAGE_ERROR',
        message: 'Napaka pri nalaganju slike'
      }
    });
  }
});

// =============================================================================
// PUT /users/password - Change Password
// =============================================================================

router.put('/password', validate(userSchemas.changePassword), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    // Get current password hash
    const user = await queryOne(
      'SELECT password_hash FROM users WHERE user_id = ?',
      [req.user.userId]
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Uporabnik ni najden'
        }
      });
    }

    // Verify current password
    const passwordMatch = await bcrypt.compare(current_password, user.password_hash);

    if (!passwordMatch) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_CURRENT_PASSWORD',
          message: 'Trenutno geslo ni pravilno'
        }
      });
    }

    // Hash new password
    const saltRounds = 12;
    const newPasswordHash = await bcrypt.hash(new_password, saltRounds);

    // Update password
    await query(`
      UPDATE users 
      SET 
        password_hash = ?,
        updated_at = NOW()
      WHERE user_id = ?
    `, [newPasswordHash, req.user.userId]);

    res.json({
      success: true,
      data: {
        message: 'Geslo je bilo uspešno spremenjeno'
      }
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'CHANGE_PASSWORD_ERROR',
        message: 'Napaka pri spreminjanju gesla'
      }
    });
  }
});

// =============================================================================
// GET /users/households - Get User's Households
// =============================================================================

router.get('/households', async (req, res) => {
  try {
    const households = await query(`
      SELECT 
        h.household_id,
        h.name,
        h.description,
        h.invite_code,
        h.created_at,
        hm.role,
        hm.joined_at,
        hm.is_active as membership_active,
        -- Member count
        (SELECT COUNT(*) FROM household_members hm2 
         WHERE hm2.household_id = h.household_id AND hm2.is_active = 1) as member_count,
        -- Task count
        (SELECT COUNT(*) FROM tasks t 
         WHERE t.household_id = h.household_id AND t.is_active = 1) as task_count
      FROM household_members hm
      JOIN households h ON hm.household_id = h.household_id
      WHERE hm.user_id = ? AND h.is_active = 1
      ORDER BY hm.joined_at DESC
    `, [req.user.userId]);

    res.json({
      success: true,
      data: {
        households
      }
    });

  } catch (error) {
    console.error('Get user households error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_HOUSEHOLDS_ERROR',
        message: 'Napaka pri pridobivanju domov'
      }
    });
  }
});

// =============================================================================
// GET /users/stats - Get User Statistics
// =============================================================================

router.get('/stats', async (req, res) => {
  try {
    const { period = '30' } = req.query; // days

    // Basic stats
    const basicStats = await queryOne(`
      SELECT 
        -- Task completion stats
        COUNT(DISTINCT tc.completion_id) as total_completions,
        COUNT(DISTINCT CASE WHEN tc.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY) THEN tc.completion_id END) as recent_completions,
        COALESCE(SUM(tc.points_earned), 0) as total_points_earned,
        COALESCE(SUM(CASE WHEN tc.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY) THEN tc.points_earned ELSE 0 END), 0) as recent_points_earned,
        -- Reward stats
        COUNT(DISTINCT rc.claim_id) as total_rewards_claimed,
        COALESCE(SUM(rc.points_spent), 0) as total_points_spent,
        -- Current balance
        COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc.points_spent), 0) as current_balance
      FROM users u
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by_user_id
      LEFT JOIN reward_claims rc ON u.user_id = rc.claimed_by_user_id AND rc.is_fulfilled = 1
      WHERE u.user_id = ?
    `, [period, period, req.user.userId]);

    // Category performance
    const categoryStats = await query(`
      SELECT 
        cat.name as category_name,
        cat.icon as category_icon,
        COUNT(tc.completion_id) as completions,
        COALESCE(SUM(tc.points_earned), 0) as points_earned,
        AVG(tc.points_earned) as avg_points_per_task
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      WHERE tc.completed_by_user_id = ? 
        AND tc.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY cat.category_id, cat.name, cat.icon
      ORDER BY points_earned DESC
    `, [req.user.userId, period]);

    // Weekly completion trend
    const weeklyTrend = await query(`
      SELECT 
        DATE(tc.completed_at) as completion_date,
        COUNT(tc.completion_id) as completions,
        SUM(tc.points_earned) as points_earned
      FROM task_completions tc
      WHERE tc.completed_by_user_id = ? 
        AND tc.completed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(tc.completed_at)
      ORDER BY completion_date
    `, [req.user.userId]);

    res.json({
      success: true,
      data: {
        basic_stats: basicStats,
        category_performance: categoryStats,
        weekly_trend: weeklyTrend,
        period_days: parseInt(period)
      }
    });

  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_STATS_ERROR',
        message: 'Napaka pri pridobivanju statistik'
      }
    });
  }
});

// =============================================================================
// DELETE /users/account - Deactivate Account
// =============================================================================

router.delete('/account', validate(userSchemas.deleteAccount), async (req, res) => {
  try {
    const { password } = req.body;

    // Get current password hash
    const user = await queryOne(
      'SELECT password_hash FROM users WHERE user_id = ?',
      [req.user.userId]
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Uporabnik ni najden'
        }
      });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PASSWORD',
          message: 'Geslo ni pravilno'
        }
      });
    }

    // Deactivate user (soft delete)
    await query(`
      UPDATE users 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE user_id = ?
    `, [req.user.userId]);

    // Deactivate household memberships
    await query(`
      UPDATE household_members 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE user_id = ?
    `, [req.user.userId]);

    res.json({
      success: true,
      data: {
        message: 'Račun je bil uspešno deaktiviran'
      }
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'DELETE_ACCOUNT_ERROR',
        message: 'Napaka pri brisanju računa'
      }
    });
  }
});

module.exports = router; 