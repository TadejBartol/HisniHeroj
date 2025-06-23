// =============================================================================
// Rewards Management Routes
// =============================================================================

const express = require('express');
const { query, queryOne, beginTransaction, commitTransaction, rollbackTransaction } = require('../models/database');
const { authenticate, requireHouseholdAccess, checkPermission } = require('../middleware/auth');
const { validate, rewardSchemas } = require('../middleware/validation');

const router = express.Router();

// Apply authentication to all reward routes
router.use(authenticate);

// =============================================================================
// GET /rewards - Get Rewards (with filtering)
// =============================================================================

router.get('/', async (req, res) => {
  try {
    const { 
      household_id, 
      is_active = '1',
      available_only = 'false',
      limit = '50',
      offset = '0'
    } = req.query;

    // Build WHERE clause
    let whereConditions = ['r.is_active = ?'];
    let whereParams = [parseInt(is_active)];

    if (household_id) {
      // Verify user has access to this household
      const hasAccess = await queryOne(`
        SELECT membership_id FROM household_members 
        WHERE household_id = ? AND user_id = ? AND is_active = 1
      `, [household_id, req.user.userId]);

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'HOUSEHOLD_ACCESS_DENIED',
            message: 'Nimate dostopa do tega doma'
          }
        });
      }

      whereConditions.push('r.household_id = ?');
      whereParams.push(parseInt(household_id));
    }

    if (available_only === 'true') {
      whereConditions.push('r.quantity > 0');
    }

    const whereClause = whereConditions.join(' AND ');

    // Get rewards
    const rewards = await query(`
      SELECT 
        r.reward_id,
        r.household_id,
        r.title,
        r.description,
        r.points_cost,
        r.quantity,
        r.is_active,
        r.created_at,
        r.updated_at,
        -- Household info
        h.name as household_name,
        -- Creator info
        creator.first_name as created_by_first_name,
        creator.last_name as created_by_last_name,
        -- Claim stats
        (SELECT COUNT(*) FROM reward_claims rc 
         WHERE rc.reward_id = r.reward_id) as total_claims,
        (SELECT COUNT(*) FROM reward_claims rc 
         WHERE rc.reward_id = r.reward_id AND rc.is_fulfilled = 0) as pending_claims,
        -- User's available points (if household_id specified)
        ${household_id ? `
        (SELECT COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc2.points_spent), 0)
         FROM task_completions tc
         LEFT JOIN reward_claims rc2 ON rc2.claimed_by_user_id = tc.completed_by_user_id AND rc2.is_fulfilled = 1
         JOIN tasks t ON tc.task_id = t.task_id
         WHERE tc.completed_by_user_id = ? AND t.household_id = ?) as user_available_points,
        ` : 'NULL as user_available_points,'}
        -- Can user afford this reward
        ${household_id ? `
        CASE WHEN (
          SELECT COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc2.points_spent), 0)
          FROM task_completions tc
          LEFT JOIN reward_claims rc2 ON rc2.claimed_by_user_id = tc.completed_by_user_id AND rc2.is_fulfilled = 1
          JOIN tasks t ON tc.task_id = t.task_id
          WHERE tc.completed_by_user_id = ? AND t.household_id = ?
        ) >= r.points_cost THEN 1 ELSE 0 END as can_afford
        ` : 'NULL as can_afford'}
      FROM rewards r
      JOIN households h ON r.household_id = h.household_id
      JOIN users creator ON r.created_by_user_id = creator.user_id
      WHERE ${whereClause}
      ORDER BY r.points_cost ASC, r.created_at DESC
      LIMIT ? OFFSET ?
    `, [
      ...(household_id ? [req.user.userId, household_id, req.user.userId, household_id] : []),
      ...whereParams, 
      parseInt(limit), 
      parseInt(offset)
    ]);

    // Get total count
    const totalResult = await queryOne(`
      SELECT COUNT(*) as total
      FROM rewards r
      WHERE ${whereClause}
    `, whereParams);

    res.json({
      success: true,
      data: {
        rewards,
        pagination: {
          total: totalResult.total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: totalResult.total > (parseInt(offset) + parseInt(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get rewards error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_REWARDS_ERROR',
        message: 'Napaka pri pridobivanju nagrad'
      }
    });
  }
});

// =============================================================================
// GET /rewards/:id - Get Single Reward
// =============================================================================

router.get('/:id', async (req, res) => {
  try {
    const rewardId = req.params.id;

    const reward = await queryOne(`
      SELECT 
        r.reward_id,
        r.household_id,
        r.title,
        r.description,
        r.points_cost,
        r.quantity,
        r.is_active,
        r.created_at,
        r.updated_at,
        r.created_by_user_id,
        -- Household info
        h.name as household_name,
        -- Creator info
        creator.first_name as created_by_first_name,
        creator.last_name as created_by_last_name,
        -- User's household membership
        hm.role as user_role
      FROM rewards r
      JOIN households h ON r.household_id = h.household_id
      JOIN users creator ON r.created_by_user_id = creator.user_id
      JOIN household_members hm ON r.household_id = hm.household_id
      WHERE r.reward_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND r.is_active = 1
    `, [rewardId, req.user.userId]);

    if (!reward) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'REWARD_NOT_FOUND',
          message: 'Nagrada ni najdena'
        }
      });
    }

    // Get recent claims for this reward
    const recentClaims = await query(`
      SELECT 
        rc.claim_id,
        rc.claimed_by_user_id,
        rc.claimed_at,
        rc.is_fulfilled,
        rc.fulfilled_at,
        rc.points_spent,
        -- Claimed by user info
        u.first_name as claimed_by_first_name,
        u.last_name as claimed_by_last_name,
        u.profile_image as claimed_by_profile_image,
        -- Fulfilled by user info
        fulfiller.first_name as fulfilled_by_first_name,
        fulfiller.last_name as fulfilled_by_last_name
      FROM reward_claims rc
      JOIN users u ON rc.claimed_by_user_id = u.user_id
      LEFT JOIN users fulfiller ON rc.fulfilled_by_user_id = fulfiller.user_id
      WHERE rc.reward_id = ?
      ORDER BY rc.claimed_at DESC
      LIMIT 10
    `, [rewardId]);

    // Get user's available points for this household
    const userPoints = await queryOne(`
      SELECT 
        COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc.points_spent), 0) as available_points
      FROM task_completions tc
      LEFT JOIN reward_claims rc ON rc.claimed_by_user_id = tc.completed_by_user_id AND rc.is_fulfilled = 1
      JOIN tasks t ON tc.task_id = t.task_id
      WHERE tc.completed_by_user_id = ? AND t.household_id = ?
    `, [req.user.userId, reward.household_id]);

    res.json({
      success: true,
      data: {
        reward,
        recent_claims: recentClaims,
        user_available_points: userPoints.available_points,
        can_afford: userPoints.available_points >= reward.points_cost,
        can_claim: userPoints.available_points >= reward.points_cost && reward.quantity > 0
      }
    });

  } catch (error) {
    console.error('Get reward error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_REWARD_ERROR',
        message: 'Napaka pri pridobivanju nagrade'
      }
    });
  }
});

// =============================================================================
// POST /rewards - Create New Reward
// =============================================================================

router.post('/', requireHouseholdAccess, checkPermission('create_rewards'), 
  validate(rewardSchemas.create), async (req, res) => {
  try {
    const {
      household_id,
      title,
      description,
      points_cost,
      quantity = 1
    } = req.body;

    // Create reward
    const rewardResult = await query(`
      INSERT INTO rewards (
        household_id, title, description, points_cost, quantity,
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [household_id, title, description, points_cost, quantity, req.user.userId]);

    const rewardId = rewardResult.insertId;

    // Fetch created reward
    const reward = await queryOne(`
      SELECT 
        r.reward_id,
        r.household_id,
        r.title,
        r.description,
        r.points_cost,
        r.quantity,
        r.created_at,
        -- Household info
        h.name as household_name
      FROM rewards r
      JOIN households h ON r.household_id = h.household_id
      WHERE r.reward_id = ?
    `, [rewardId]);

    res.status(201).json({
      success: true,
      data: {
        reward,
        message: 'Nagrada je bila uspešno ustvarjena'
      }
    });

  } catch (error) {
    console.error('Create reward error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'CREATE_REWARD_ERROR',
        message: 'Napaka pri ustvarjanju nagrade'
      }
    });
  }
});

// =============================================================================
// PUT /rewards/:id - Update Reward
// =============================================================================

router.put('/:id', requireHouseholdAccess, checkPermission('create_rewards'), 
  validate(rewardSchemas.update), async (req, res) => {
  try {
    const rewardId = req.params.id;
    const {
      title,
      description,
      points_cost,
      quantity
    } = req.body;

    // Check if reward exists and user has access
    const existingReward = await queryOne(`
      SELECT 
        r.reward_id,
        r.household_id,
        hm.role as user_role
      FROM rewards r
      JOIN household_members hm ON r.household_id = hm.household_id
      WHERE r.reward_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND r.is_active = 1
    `, [rewardId, req.user.userId]);

    if (!existingReward) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'REWARD_NOT_FOUND',
          message: 'Nagrada ni najdena'
        }
      });
    }

    // Update reward
    await query(`
      UPDATE rewards 
      SET 
        title = ?, 
        description = ?, 
        points_cost = ?, 
        quantity = ?,
        updated_at = NOW()
      WHERE reward_id = ?
    `, [title, description, points_cost, quantity, rewardId]);

    // Fetch updated reward
    const reward = await queryOne(`
      SELECT 
        r.reward_id,
        r.household_id,
        r.title,
        r.description,
        r.points_cost,
        r.quantity,
        r.created_at,
        r.updated_at,
        -- Household info
        h.name as household_name
      FROM rewards r
      JOIN households h ON r.household_id = h.household_id
      WHERE r.reward_id = ?
    `, [rewardId]);

    res.json({
      success: true,
      data: {
        reward,
        message: 'Nagrada je bila uspešno posodobljena'
      }
    });

  } catch (error) {
    console.error('Update reward error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'UPDATE_REWARD_ERROR',
        message: 'Napaka pri posodabljanju nagrade'
      }
    });
  }
});

// =============================================================================
// DELETE /rewards/:id - Delete Reward
// =============================================================================

router.delete('/:id', requireHouseholdAccess, checkPermission('create_rewards'), 
  async (req, res) => {
  try {
    const rewardId = req.params.id;

    // Check if reward exists and user has access
    const existingReward = await queryOne(`
      SELECT 
        r.reward_id,
        r.title,
        r.household_id,
        hm.role as user_role
      FROM rewards r
      JOIN household_members hm ON r.household_id = hm.household_id
      WHERE r.reward_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND r.is_active = 1
    `, [rewardId, req.user.userId]);

    if (!existingReward) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'REWARD_NOT_FOUND',
          message: 'Nagrada ni najdena'
        }
      });
    }

    // Check for pending claims
    const pendingClaims = await queryOne(`
      SELECT COUNT(*) as pending_count
      FROM reward_claims 
      WHERE reward_id = ? AND is_fulfilled = 0
    `, [rewardId]);

    if (pendingClaims.pending_count > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'REWARD_HAS_PENDING_CLAIMS',
          message: 'Nagrade z neizvršenimi zahtevki ni mogoče izbrisati'
        }
      });
    }

    // Soft delete reward
    await query(`
      UPDATE rewards 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE reward_id = ?
    `, [rewardId]);

    res.json({
      success: true,
      data: {
        message: `Nagrada "${existingReward.title}" je bila uspešno izbrisana`
      }
    });

  } catch (error) {
    console.error('Delete reward error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'DELETE_REWARD_ERROR',
        message: 'Napaka pri brisanju nagrade'
      }
    });
  }
});

// =============================================================================
// POST /rewards/:id/claim - Claim Reward
// =============================================================================

router.post('/:id/claim', validate(rewardSchemas.claim), async (req, res) => {
  let connection;
  
  try {
    const rewardId = req.params.id;

    // Begin transaction
    connection = await beginTransaction();

    // Get reward details
    const reward = await queryOne(`
      SELECT 
        r.reward_id,
        r.household_id,
        r.title,
        r.points_cost,
        r.quantity,
        r.is_active
      FROM rewards r
      JOIN household_members hm ON r.household_id = hm.household_id
      WHERE r.reward_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND r.is_active = 1
    `, [rewardId, req.user.userId]);

    if (!reward) {
      await rollbackTransaction(connection);
      return res.status(404).json({
        success: false,
        error: {
          code: 'REWARD_NOT_FOUND',
          message: 'Nagrada ni najdena'
        }
      });
    }

    // Check if reward is available
    if (reward.quantity <= 0) {
      await rollbackTransaction(connection);
      return res.status(400).json({
        success: false,
        error: {
          code: 'REWARD_NOT_AVAILABLE',
          message: 'Nagrada ni več na voljo'
        }
      });
    }

    // Check user's available points
    const userPoints = await queryOne(`
      SELECT 
        COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc.points_spent), 0) as available_points
      FROM task_completions tc
      LEFT JOIN reward_claims rc ON rc.claimed_by_user_id = tc.completed_by_user_id AND rc.is_fulfilled = 1
      JOIN tasks t ON tc.task_id = t.task_id
      WHERE tc.completed_by_user_id = ? AND t.household_id = ?
    `, [req.user.userId, reward.household_id]);

    if (userPoints.available_points < reward.points_cost) {
      await rollbackTransaction(connection);
      return res.status(400).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_POINTS',
          message: `Potrebujete ${reward.points_cost} točk, imate pa ${userPoints.available_points} točk`
        }
      });
    }

    // Create reward claim
    const claimResult = await connection.execute(`
      INSERT INTO reward_claims (
        reward_id, claimed_by_user_id, claimed_at, points_spent
      ) VALUES (?, ?, NOW(), ?)
    `, [rewardId, req.user.userId, reward.points_cost]);

    const claimId = claimResult[0].insertId;

    // Decrease reward quantity
    await connection.execute(`
      UPDATE rewards 
      SET 
        quantity = quantity - 1,
        updated_at = NOW()
      WHERE reward_id = ?
    `, [rewardId]);

    // Commit transaction
    await commitTransaction(connection);

    // Fetch claim details
    const claim = await queryOne(`
      SELECT 
        rc.claim_id,
        rc.reward_id,
        rc.claimed_at,
        rc.points_spent,
        rc.is_fulfilled,
        -- Reward info
        r.title as reward_title,
        r.description as reward_description
      FROM reward_claims rc
      JOIN rewards r ON rc.reward_id = r.reward_id
      WHERE rc.claim_id = ?
    `, [claimId]);

    res.status(201).json({
      success: true,
      data: {
        claim,
        remaining_points: userPoints.available_points - reward.points_cost,
        message: `Uspešno ste uveljavljali nagradno "${reward.title}" za ${reward.points_cost} točk`
      }
    });

  } catch (error) {
    if (connection) {
      await rollbackTransaction(connection);
    }

    console.error('Claim reward error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'CLAIM_REWARD_ERROR',
        message: 'Napaka pri uveljavljanju nagrade'
      }
    });
  }
});

// =============================================================================
// GET /rewards/claims/my - Get User's Reward Claims
// =============================================================================

router.get('/claims/my', async (req, res) => {
  try {
    const { 
      household_id,
      is_fulfilled,
      limit = '50',
      offset = '0'
    } = req.query;

    // Build WHERE clause
    let whereConditions = ['rc.claimed_by_user_id = ?'];
    let whereParams = [req.user.userId];

    if (household_id) {
      // Verify access
      const hasAccess = await queryOne(`
        SELECT membership_id FROM household_members 
        WHERE household_id = ? AND user_id = ? AND is_active = 1
      `, [household_id, req.user.userId]);

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'HOUSEHOLD_ACCESS_DENIED',
            message: 'Nimate dostopa do tega doma'
          }
        });
      }

      whereConditions.push('r.household_id = ?');
      whereParams.push(parseInt(household_id));
    }

    if (is_fulfilled !== undefined) {
      whereConditions.push('rc.is_fulfilled = ?');
      whereParams.push(parseInt(is_fulfilled));
    }

    const whereClause = whereConditions.join(' AND ');

    // Get claims
    const claims = await query(`
      SELECT 
        rc.claim_id,
        rc.reward_id,
        rc.claimed_at,
        rc.is_fulfilled,
        rc.fulfilled_at,
        rc.points_spent,
        -- Reward info
        r.title as reward_title,
        r.description as reward_description,
        r.household_id,
        -- Household info
        h.name as household_name,
        -- Fulfilled by user info
        fulfiller.first_name as fulfilled_by_first_name,
        fulfiller.last_name as fulfilled_by_last_name
      FROM reward_claims rc
      JOIN rewards r ON rc.reward_id = r.reward_id
      JOIN households h ON r.household_id = h.household_id
      LEFT JOIN users fulfiller ON rc.fulfilled_by_user_id = fulfiller.user_id
      WHERE ${whereClause}
      ORDER BY rc.claimed_at DESC
      LIMIT ? OFFSET ?
    `, [...whereParams, parseInt(limit), parseInt(offset)]);

    // Get total count
    const totalResult = await queryOne(`
      SELECT COUNT(*) as total
      FROM reward_claims rc
      JOIN rewards r ON rc.reward_id = r.reward_id
      WHERE ${whereClause}
    `, whereParams);

    res.json({
      success: true,
      data: {
        claims,
        pagination: {
          total: totalResult.total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: totalResult.total > (parseInt(offset) + parseInt(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get user reward claims error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_REWARD_CLAIMS_ERROR',
        message: 'Napaka pri pridobivanju uveljavitev nagrad'
      }
    });
  }
});

// =============================================================================
// POST /rewards/claims/:id/fulfill - Fulfill Reward Claim
// =============================================================================

router.post('/claims/:id/fulfill', requireHouseholdAccess, checkPermission('fulfill_rewards'), 
  async (req, res) => {
  try {
    const claimId = req.params.id;

    // Check if claim exists and user has access
    const claim = await queryOne(`
      SELECT 
        rc.claim_id,
        rc.reward_id,
        rc.claimed_by_user_id,
        rc.is_fulfilled,
        r.title as reward_title,
        r.household_id,
        -- Claimed by user info
        u.first_name as claimed_by_first_name,
        u.last_name as claimed_by_last_name
      FROM reward_claims rc
      JOIN rewards r ON rc.reward_id = r.reward_id
      JOIN users u ON rc.claimed_by_user_id = u.user_id
      JOIN household_members hm ON r.household_id = hm.household_id
      WHERE rc.claim_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `, [claimId, req.user.userId]);

    if (!claim) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CLAIM_NOT_FOUND',
          message: 'Uveljavitev nagrade ni najdena'
        }
      });
    }

    if (claim.is_fulfilled) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CLAIM_ALREADY_FULFILLED',
          message: 'Uveljavitev nagrade je že izvedena'
        }
      });
    }

    // Fulfill the claim
    await query(`
      UPDATE reward_claims 
      SET 
        is_fulfilled = 1,
        fulfilled_at = NOW(),
        fulfilled_by_user_id = ?
      WHERE claim_id = ?
    `, [req.user.userId, claimId]);

    res.json({
      success: true,
      data: {
        message: `Uveljavitev nagrade "${claim.reward_title}" za ${claim.claimed_by_first_name} ${claim.claimed_by_last_name} je bila označena kot izvedena`
      }
    });

  } catch (error) {
    console.error('Fulfill reward claim error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'FULFILL_REWARD_CLAIM_ERROR',
        message: 'Napaka pri označevanju izvedbe nagrade'
      }
    });
  }
});

module.exports = router;