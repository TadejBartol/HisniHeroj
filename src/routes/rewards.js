// =============================================================================
// Rewards Management Routes
// =============================================================================

const express = require('express');
const { query, queryOne, beginTransaction, commitTransaction, rollbackTransaction } = require('../models/database');
const { requireHouseholdAccess, requirePermission } = require('../middleware/auth');
const { validate, rewardSchemas } = require('../middleware/validation');

const router = express.Router();

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
        r.cost_points,
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
         WHERE rc.reward_id = r.reward_id AND rc.status = 'pending') as pending_claims,
        -- User's available points (if household_id specified)
        ${household_id ? `
        (SELECT COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc2.points_spent), 0)
         FROM task_completions tc
         LEFT JOIN reward_claims rc2 ON rc2.claimed_by = tc.completed_by AND rc2.status = 'fulfilled'
         JOIN task_assignments ta ON tc.assignment_id = ta.assignment_id
         JOIN tasks t ON ta.task_id = t.task_id
         WHERE tc.completed_by = ? AND t.household_id = ?) as user_available_points,
        ` : 'NULL as user_available_points,'}
        -- Can user afford this reward
        ${household_id ? `
        CASE WHEN (
          SELECT COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc2.points_spent), 0)
          FROM task_completions tc
          LEFT JOIN reward_claims rc2 ON rc2.claimed_by = tc.completed_by AND rc2.status = 'fulfilled'
          JOIN task_assignments ta ON tc.assignment_id = ta.assignment_id
          JOIN tasks t ON ta.task_id = t.task_id
          WHERE tc.completed_by = ? AND t.household_id = ?
        ) >= r.cost_points THEN 1 ELSE 0 END as can_afford
        ` : 'NULL as can_afford'}
      FROM rewards r
      JOIN households h ON r.household_id = h.household_id
      JOIN users creator ON r.created_by = creator.user_id
      WHERE ${whereClause}
      ORDER BY r.cost_points ASC, r.created_at DESC
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
        r.cost_points,
        r.quantity,
        r.is_active,
        r.created_at,
        r.updated_at,
        r.created_by,
        -- Household info
        h.name as household_name,
        -- Creator info
        creator.first_name as created_by_first_name,
        creator.last_name as created_by_last_name,
        -- User's household membership
        hm.role as user_role
      FROM rewards r
      JOIN households h ON r.household_id = h.household_id
      JOIN users creator ON r.created_by = creator.user_id
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
        rc.claimed_by,
        rc.claimed_at,
        rc.status,
        rc.fulfilled_at,
        rc.points_spent,
        -- Claimed by user info
        u.first_name as claimed_by_first_name,
        u.last_name as claimed_by_last_name,
        u.profile_image as claimed_by_profile_image
      FROM reward_claims rc
      JOIN users u ON rc.claimed_by = u.user_id
      WHERE rc.reward_id = ?
      ORDER BY rc.claimed_at DESC
      LIMIT 10
    `, [rewardId]);

    // Get user's available points for this household
    const userPoints = await queryOne(`
      SELECT 
        COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc.points_spent), 0) as available_points
      FROM task_completions tc
      LEFT JOIN reward_claims rc ON rc.claimed_by = tc.completed_by AND rc.status = 'fulfilled'
      JOIN task_assignments ta ON tc.assignment_id = ta.assignment_id
      JOIN tasks t ON ta.task_id = t.task_id
      WHERE tc.completed_by = ? AND t.household_id = ?
    `, [req.user.userId, reward.household_id]);

    res.json({
      success: true,
      data: {
        reward,
        recent_claims: recentClaims,
        user_available_points: userPoints.available_points,
        can_afford: userPoints.available_points >= reward.cost_points,
        can_claim: userPoints.available_points >= reward.cost_points && reward.quantity > 0
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

router.post('/', validate(rewardSchemas.create), async (req, res) => {
  try {
    const {
      household_id,
      title,
      description,
      points_cost,
      quantity = 1
    } = req.body;

    // Verify access and permissions
    const hasAccess = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role,
        hm.can_create_rewards
      FROM household_members hm
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
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

    // Check can_create_rewards permission
    if (hasAccess.role !== 'owner' && hasAccess.role !== 'admin' && !hasAccess.can_create_rewards) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Nimate dovoljenj za ustvarjanje nagrad'
        }
      });
    }

    // Create reward
    const rewardResult = await query(`
      INSERT INTO rewards (
        household_id, title, description, cost_points, quantity,
        created_by, created_at
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
        r.cost_points,
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

router.put('/:id', validate(rewardSchemas.update), async (req, res) => {
  try {
    const rewardId = req.params.id;
    const {
      title,
      description,
      cost_points,
      quantity
    } = req.body;

    // Check if reward exists and get household_id
    const rewardInfo = await queryOne(`
      SELECT 
        r.reward_id,
        r.household_id
      FROM rewards r
      WHERE r.reward_id = ? AND r.is_active = 1
    `, [rewardId]);

    if (!rewardInfo) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'REWARD_NOT_FOUND',
          message: 'Nagrada ni najdena'
        }
      });
    }

    // Verify access and permissions
    const hasAccess = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role,
        hm.can_create_rewards
      FROM household_members hm
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `, [rewardInfo.household_id, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega doma'
        }
      });
    }

    // Check can_create_rewards permission
    if (hasAccess.role !== 'owner' && hasAccess.role !== 'admin' && !hasAccess.can_create_rewards) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Nimate dovoljenj za urejanje nagrad'
        }
      });
    }

    // Update reward
    await query(`
      UPDATE rewards 
      SET 
        title = ?, 
        description = ?, 
        cost_points = ?, 
        quantity = ?,
        updated_at = NOW()
      WHERE reward_id = ?
    `, [title, description, cost_points, quantity, rewardId]);

    // Fetch updated reward
    const reward = await queryOne(`
      SELECT 
        r.reward_id,
        r.household_id,
        r.title,
        r.description,
        r.cost_points,
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

router.delete('/:id', async (req, res) => {
  try {
    const rewardId = req.params.id;

    // Check if reward exists and get household_id
    const rewardInfo = await queryOne(`
      SELECT 
        r.reward_id,
        r.title,
        r.household_id
      FROM rewards r
      WHERE r.reward_id = ? AND r.is_active = 1
    `, [rewardId]);

    if (!rewardInfo) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'REWARD_NOT_FOUND',
          message: 'Nagrada ni najdena'
        }
      });
    }

    // Verify access and permissions
    const hasAccess = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role,
        hm.can_create_rewards
      FROM household_members hm
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `, [rewardInfo.household_id, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega doma'
        }
      });
    }

    // Check can_create_rewards permission
    if (hasAccess.role !== 'owner' && hasAccess.role !== 'admin' && !hasAccess.can_create_rewards) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Nimate dovoljenj za brisanje nagrad'
        }
      });
    }

    // Check for pending claims
    const pendingClaims = await queryOne(`
      SELECT COUNT(*) as pending_count
      FROM reward_claims 
      WHERE reward_id = ? AND status = 'pending'
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
        message: `Nagrada "${rewardInfo.title}" je bila uspešno izbrisana`
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
        r.cost_points,
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
      LEFT JOIN reward_claims rc ON rc.claimed_by = tc.completed_by AND rc.status = 'fulfilled'
      JOIN task_assignments ta ON tc.assignment_id = ta.assignment_id
      JOIN tasks t ON ta.task_id = t.task_id
      WHERE tc.completed_by = ? AND t.household_id = ?
    `, [req.user.userId, reward.household_id]);

    if (userPoints.available_points < reward.cost_points) {
      await rollbackTransaction(connection);
      return res.status(400).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_POINTS',
          message: `Potrebujete ${reward.cost_points} točk, imate pa ${userPoints.available_points} točk`
        }
      });
    }

    // Create reward claim
    const claimResult = await connection.execute(`
      INSERT INTO reward_claims (
        reward_id, claimed_by, claimed_at, points_spent
      ) VALUES (?, ?, NOW(), ?)
    `, [rewardId, req.user.userId, reward.cost_points]);

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
        rc.status,
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
        remaining_points: userPoints.available_points - reward.cost_points,
        message: `Uspešno ste uveljavljali nagradno "${reward.title}" za ${reward.cost_points} točk`
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
    let whereConditions = ['rc.claimed_by = ?'];
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
      whereConditions.push('rc.status = ?');
      whereParams.push(is_fulfilled === '1' ? 'fulfilled' : 'pending');
    }

    const whereClause = whereConditions.join(' AND ');

    // Get claims
    const claims = await query(`
      SELECT 
        rc.claim_id,
        rc.reward_id,
        rc.claimed_at,
        rc.status,
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

router.post('/claims/:id/fulfill', async (req, res) => {
  try {
    const claimId = req.params.id;

    // Check if claim exists and get household info
    const claimInfo = await queryOne(`
      SELECT 
        rc.claim_id,
        rc.reward_id,
        rc.claimed_by,
        rc.status,
        r.title as reward_title,
        r.household_id,
        -- Claimed by user info
        u.first_name as claimed_by_first_name,
        u.last_name as claimed_by_last_name
      FROM reward_claims rc
      JOIN rewards r ON rc.reward_id = r.reward_id
      JOIN users u ON rc.claimed_by = u.user_id
      WHERE rc.claim_id = ?
    `, [claimId]);

    if (!claimInfo) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CLAIM_NOT_FOUND',
          message: 'Uveljavitev nagrade ni najdena'
        }
      });
    }

    // Verify access and permissions
    const hasAccess = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role,
        hm.can_create_rewards
      FROM household_members hm
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `, [claimInfo.household_id, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega doma'
        }
      });
    }

    // Check can_create_rewards permission
    if (hasAccess.role !== 'owner' && hasAccess.role !== 'admin' && !hasAccess.can_create_rewards) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Nimate dovoljenj za izvedbo nagrad'
        }
      });
    }

    if (claimInfo.status === 'fulfilled') {
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
        status = 'fulfilled',
        fulfilled_at = NOW(),
        fulfilled_by_user_id = ?
      WHERE claim_id = ?
    `, [req.user.userId, claimId]);

    res.json({
      success: true,
      data: {
        message: `Uveljavitev nagrade "${claimInfo.reward_title}" za ${claimInfo.claimed_by_first_name} ${claimInfo.claimed_by_last_name} je bila označena kot izvedena`
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

// =============================================================================
// GET /rewards/claims - List all reward claims (admin/owner)
// =============================================================================

router.get('/claims', async (req, res) => {
  try {
    const { household_id, status='all', limit='50', offset='0' } = req.query;

    // Must be owner/admin of given household, otherwise deny
    if (!household_id) {
      return res.status(400).json({ success:false, error:{ code:'HOUSEHOLD_REQUIRED', message:'Manjka household_id' } });
    }

    const member = await queryOne(`SELECT role FROM household_members WHERE household_id=? AND user_id=? AND is_active=1`, [household_id, req.user.userId]);
    if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
      return res.status(403).json({ success:false, error:{ code:'PERMISSION_DENIED', message:'Nimate dovoljenja' } });
    }

    const whereParts = ['r.household_id = ?'];
    const params = [household_id];
    if (status !== 'all') { whereParts.push('rc.status = ?'); params.push(status); }

    const claims = await query(`
      SELECT rc.*, r.title as reward_title, u.first_name, u.last_name
      FROM reward_claims rc
      JOIN rewards r ON rc.reward_id = r.reward_id
      JOIN users u ON rc.claimed_by = u.user_id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY rc.claimed_at DESC
      LIMIT ? OFFSET ?`, [...params, parseInt(limit), parseInt(offset)]);

    res.json({ success:true, data:{ claims } });

  } catch (error) {
    console.error('List reward claims error:', error);
    res.status(500).json({ success:false, error:{ code:'LIST_CLAIMS_ERROR', message:'Napaka pri pridobivanju zahtevkov' } });
  }
});

// =============================================================================
// GET /rewards/claims/:id - Claim detail (requires access)
// =============================================================================

router.get('/claims/:id', async (req, res) => {
  try {
    const claimId = req.params.id;
    const claim = await queryOne(`
      SELECT rc.*, r.title as reward_title, r.household_id, u.first_name, u.last_name
      FROM reward_claims rc
      JOIN rewards r ON rc.reward_id = r.reward_id
      JOIN users u ON rc.claimed_by = u.user_id
      WHERE rc.claim_id = ?`, [claimId]);

    if (!claim) return res.status(404).json({ success:false, error:{ code:'CLAIM_NOT_FOUND', message:'Zahtevek ni najden' } });

    // Access check
    const member = await queryOne(`SELECT role FROM household_members WHERE household_id=? AND user_id=? AND is_active=1`, [claim.household_id, req.user.userId]);
    if (!member) return res.status(403).json({ success:false, error:{ code:'PERMISSION_DENIED', message:'Dostop zavrnjen' } });

    res.json({ success:true, data:{ claim } });

  } catch (error) {
    console.error('Get claim detail error:', error);
    res.status(500).json({ success:false, error:{ code:'GET_CLAIM_ERROR', message:'Napaka pri podrobnostih zahtevka' } });
  }
});

// =============================================================================
// POST /rewards/claims/:id/reject - Reject claim
// =============================================================================

router.post('/claims/:id/reject', async (req, res) => {
  try {
    const claimId = req.params.id;
    const { admin_notes='' } = req.body;

    const claim = await queryOne(`SELECT rc.*, r.household_id, r.title as reward_title FROM reward_claims rc JOIN rewards r ON rc.reward_id = r.reward_id WHERE rc.claim_id = ?`, [claimId]);
    if (!claim) return res.status(404).json({ success:false, error:{ code:'CLAIM_NOT_FOUND', message:'Zahtevek ni najden' } });

    const member = await queryOne(`SELECT role FROM household_members WHERE household_id=? AND user_id=? AND is_active=1`, [claim.household_id, req.user.userId]);
    if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
      return res.status(403).json({ success:false, error:{ code:'PERMISSION_DENIED', message:'Nimate dovoljenja' } });
    }

    if (claim.status !== 'pending') {
      return res.status(400).json({ success:false, error:{ code:'INVALID_STATUS', message:'Zahtevek ni več v stanju pending' } });
    }

    await query(`UPDATE reward_claims SET status='cancelled', admin_notes=? , fulfilled_by_user_id=? , fulfilled_at=NOW() WHERE claim_id=?`, [admin_notes, req.user.userId, claimId]);

    res.json({ success:true, data:{ message:`Zahtevek za nagrado "${claim.reward_title}" zavrnjen.` } });

  } catch (error) {
    console.error('Reject claim error:', error);
    res.status(500).json({ success:false, error:{ code:'REJECT_CLAIM_ERROR', message:'Napaka pri zavrnitvi zahtevka' } });
  }
});

// =============================================================================
// DELETE /rewards/claims/:id - Cancel own pending claim
// =============================================================================

router.delete('/claims/:id', async (req,res)=>{
  try {
    const claimId = req.params.id;
    const claim = await queryOne('SELECT * FROM reward_claims WHERE claim_id=?', [claimId]);
    if (!claim) return res.status(404).json({ success:false, error:{ code:'CLAIM_NOT_FOUND', message:'Zahtevek ni najden' } });

    if (claim.claimed_by !== req.user.userId) {
      return res.status(403).json({ success:false, error:{ code:'PERMISSION_DENIED', message:'Lahko prekličete le svoje zahteve' } });
    }

    if (claim.status !== 'pending') {
      return res.status(400).json({ success:false, error:{ code:'INVALID_STATUS', message:'Zahtevek ni več v stanju pending' } });
    }

    await query('DELETE FROM reward_claims WHERE claim_id = ?', [claimId]);
    res.json({ success:true, data:{ message:'Zahtevek preklican' } });

  } catch (error) {
    console.error('Delete claim error:', error);
    res.status(500).json({ success:false, error:{ code:'DELETE_CLAIM_ERROR', message:'Napaka pri preklicu zahtevka' } });
  }
});

module.exports = router;
