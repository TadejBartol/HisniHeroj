// =============================================================================
// Household Management Routes
// =============================================================================

const express = require('express');
const crypto = require('crypto');
const { query, queryOne, beginTransaction, commitTransaction, rollbackTransaction } = require('../models/database');
const { requireHouseholdAccess, requirePermission } = require('../middleware/auth');
const { validate, householdSchemas } = require('../middleware/validation');

const router = express.Router();

// =============================================================================
// POST /households - Create New Household
// =============================================================================

router.post('/', validate(householdSchemas.create), async (req, res) => {
  let connection;
  
  try {
    const { name, description } = req.body;

    // Generate unique invite code
    const generateInviteCode = () => {
      return crypto.randomBytes(4).toString('hex').toUpperCase();
    };

    let inviteCode;
    let codeExists = true;
    
    // Ensure unique invite code
    while (codeExists) {
      inviteCode = generateInviteCode();
      const existing = await queryOne(
        'SELECT household_id FROM households WHERE invite_code = ?',
        [inviteCode]
      );
      codeExists = !!existing;
    }

    // Begin transaction
    connection = await beginTransaction();

    // Create household
    const householdResult = await connection.execute(`
      INSERT INTO households (name, description, invite_code, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `, [name, description, inviteCode, req.user.userId]);

    const householdId = householdResult[0].insertId;

    // Add creator as admin member
    await connection.execute(`
      INSERT INTO household_members (household_id, user_id, role, joined_at)
      VALUES (?, ?, 'admin', NOW())
    `, [householdId, req.user.userId]);

    // Commit transaction
    await commitTransaction(connection);

    // Fetch complete household data
    const household = await queryOne(`
      SELECT 
        h.household_id,
        h.name,
        h.description,
        h.invite_code,
        h.created_at,
        h.created_by_user_id,
        -- Creator info
        u.first_name as creator_first_name,
        u.last_name as creator_last_name,
        -- Stats
        (SELECT COUNT(*) FROM household_members hm 
         WHERE hm.household_id = h.household_id AND hm.is_active = 1) as member_count,
        (SELECT COUNT(*) FROM tasks t 
         WHERE t.household_id = h.household_id AND t.is_active = 1) as task_count
      FROM households h
      JOIN users u ON h.created_by_user_id = u.user_id
      WHERE h.household_id = ?
    `, [householdId]);

    res.status(201).json({
      success: true,
      data: {
        household,
        message: 'Dom je bil uspešno ustvarjen'
      }
    });

  } catch (error) {
    if (connection) {
      await rollbackTransaction(connection);
    }
    
    console.error('Create household error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'CREATE_HOUSEHOLD_ERROR',
        message: 'Napaka pri ustvarjanju doma'
      }
    });
  }
});

// =============================================================================
// POST /households/join - Join Household with Invite Code
// =============================================================================

router.post('/join', validate(householdSchemas.join), async (req, res) => {
  let connection;
  
  try {
    const { invite_code } = req.body;

    // Find household by invite code
    const household = await queryOne(`
      SELECT 
        household_id,
        name,
        description,
        is_active
      FROM households 
      WHERE invite_code = ? AND is_active = 1
    `, [invite_code.toUpperCase()]);

    if (!household) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'INVALID_INVITE_CODE',
          message: 'Povabilo ni veljavno ali je poteklo'
        }
      });
    }

    // Check if user is already a member
    const existingMembership = await queryOne(`
      SELECT membership_id FROM household_members 
      WHERE household_id = ? AND user_id = ?
    `, [household.household_id, req.user.userId]);

    if (existingMembership) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_MEMBER',
          message: 'Že ste član tega doma'
        }
      });
    }

    // Begin transaction
    connection = await beginTransaction();

    // Add user as member
    await connection.execute(`
      INSERT INTO household_members (household_id, user_id, role, joined_at)
      VALUES (?, ?, 'member', NOW())
    `, [household.household_id, req.user.userId]);

    // Commit transaction
    await commitTransaction(connection);

    // Fetch complete household data with user's role
    const householdData = await queryOne(`
      SELECT 
        h.household_id,
        h.name,
        h.description,
        h.invite_code,
        h.created_at,
        hm.role as user_role,
        hm.joined_at as user_joined_at,
        -- Stats
        (SELECT COUNT(*) FROM household_members hm2 
         WHERE hm2.household_id = h.household_id AND hm2.is_active = 1) as member_count,
        (SELECT COUNT(*) FROM tasks t 
         WHERE t.household_id = h.household_id AND t.is_active = 1) as task_count
      FROM households h
      JOIN household_members hm ON h.household_id = hm.household_id
      WHERE h.household_id = ? AND hm.user_id = ?
    `, [household.household_id, req.user.userId]);

    res.json({
      success: true,
      data: {
        household: householdData,
        message: 'Uspešno ste se pridružili domu'
      }
    });

  } catch (error) {
    if (connection) {
      await rollbackTransaction(connection);
    }
    
    console.error('Join household error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'JOIN_HOUSEHOLD_ERROR',
        message: 'Napaka pri pridruževanju domu'
      }
    });
  }
});

// =============================================================================
// GET /households/:id - Get Household Details
// =============================================================================

router.get('/:id', requireHouseholdAccess, async (req, res) => {
  try {
    const householdId = req.params.id;

    // Get household details
    const household = await queryOne(`
      SELECT 
        h.household_id,
        h.name,
        h.description,
        h.invite_code,
        h.created_at,
        h.created_by_user_id,
        -- Creator info
        creator.first_name as creator_first_name,
        creator.last_name as creator_last_name,
        -- Current user's role
        hm.role as user_role,
        hm.joined_at as user_joined_at,
        -- Stats
        (SELECT COUNT(*) FROM household_members hm2 
         WHERE hm2.household_id = h.household_id AND hm2.is_active = 1) as member_count,
        (SELECT COUNT(*) FROM tasks t 
         WHERE t.household_id = h.household_id AND t.is_active = 1) as task_count,
        (SELECT COUNT(*) FROM rewards r 
         WHERE r.household_id = h.household_id AND r.is_active = 1) as reward_count
      FROM households h
      JOIN users creator ON h.created_by_user_id = creator.user_id
      JOIN household_members hm ON h.household_id = hm.household_id
      WHERE h.household_id = ? AND hm.user_id = ? AND h.is_active = 1
    `, [householdId, req.user.userId]);

    if (!household) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_NOT_FOUND',
          message: 'Dom ni najden'
        }
      });
    }

    // Get members
    const members = await query(`
      SELECT 
        hm.user_id,
        hm.role,
        hm.joined_at,
        u.first_name,
        u.last_name,
        u.profile_image,
        u.last_login,
        -- Member stats
        COALESCE(SUM(tc.points_earned), 0) as points_earned,
        COUNT(tc.completion_id) as tasks_completed
      FROM household_members hm
      JOIN users u ON hm.user_id = u.user_id
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by_user_id 
        AND tc.task_id IN (SELECT task_id FROM tasks WHERE household_id = ?)
      WHERE hm.household_id = ? AND hm.is_active = 1 AND u.is_active = 1
      GROUP BY hm.user_id, hm.role, hm.joined_at, u.first_name, u.last_name, u.profile_image, u.last_login
      ORDER BY hm.joined_at
    `, [householdId, householdId]);

    res.json({
      success: true,
      data: {
        household,
        members
      }
    });

  } catch (error) {
    console.error('Get household error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_HOUSEHOLD_ERROR',
        message: 'Napaka pri pridobivanju podatkov o domu'
      }
    });
  }
});

// =============================================================================
// PUT /households/:id - Update Household
// =============================================================================

router.put('/:id', requireHouseholdAccess, requirePermission('manage_household'), 
  validate(householdSchemas.update), async (req, res) => {
  try {
    const householdId = req.params.id;
    const { name, description } = req.body;

    // Update household
    await query(`
      UPDATE households 
      SET 
        name = ?,
        description = ?,
        updated_at = NOW()
      WHERE household_id = ?
    `, [name, description, householdId]);

    // Fetch updated household
    const household = await queryOne(`
      SELECT 
        household_id,
        name,
        description,
        invite_code,
        created_at,
        updated_at
      FROM households 
      WHERE household_id = ?
    `, [householdId]);

    res.json({
      success: true,
      data: {
        household,
        message: 'Dom je bil uspešno posodobljen'
      }
    });

  } catch (error) {
    console.error('Update household error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'UPDATE_HOUSEHOLD_ERROR',
        message: 'Napaka pri posodabljanju doma'
      }
    });
  }
});

// =============================================================================
// POST /households/:id/regenerate-invite - Regenerate Invite Code
// =============================================================================

router.post('/:id/regenerate-invite', requireHouseholdAccess, requirePermission('manage_household'), 
  async (req, res) => {
  try {
    const householdId = req.params.id;

    // Generate new unique invite code
    const generateInviteCode = () => {
      return crypto.randomBytes(4).toString('hex').toUpperCase();
    };

    let inviteCode;
    let codeExists = true;
    
    while (codeExists) {
      inviteCode = generateInviteCode();
      const existing = await queryOne(
        'SELECT household_id FROM households WHERE invite_code = ? AND household_id != ?',
        [inviteCode, householdId]
      );
      codeExists = !!existing;
    }

    // Update household with new invite code
    await query(`
      UPDATE households 
      SET 
        invite_code = ?,
        updated_at = NOW()
      WHERE household_id = ?
    `, [inviteCode, householdId]);

    res.json({
      success: true,
      data: {
        invite_code: inviteCode,
        message: 'Koda za povabilo je bila uspešno regenerirana'
      }
    });

  } catch (error) {
    console.error('Regenerate invite code error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'REGENERATE_INVITE_ERROR',
        message: 'Napaka pri regeneraciji kode za povabilo'
      }
    });
  }
});

// =============================================================================
// PUT /households/:id/members/:userId/role - Update Member Role
// =============================================================================

router.put('/:id/members/:userId/role', requireHouseholdAccess, requirePermission('manage_members'), 
  validate(householdSchemas.updateMemberRole), async (req, res) => {
  try {
    const householdId = req.params.id;
    const userId = req.params.userId;
    const { role } = req.body;

    // Check if member exists
    const member = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role as current_role,
        u.first_name,
        u.last_name
      FROM household_members hm
      JOIN users u ON hm.user_id = u.user_id
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `, [householdId, userId]);

    if (!member) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'MEMBER_NOT_FOUND',
          message: 'Član ni najden'
        }
      });
    }

    // Don't allow changing own role
    if (parseInt(userId) === req.user.userId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CANNOT_CHANGE_OWN_ROLE',
          message: 'Ne morete spremeniti lastne vloge'
        }
      });
    }

    // Update member role
    await query(`
      UPDATE household_members 
      SET 
        role = ?,
        updated_at = NOW()
      WHERE membership_id = ?
    `, [role, member.membership_id]);

    res.json({
      success: true,
      data: {
        message: `Vloga člana ${member.first_name} ${member.last_name} je bila spremenjena na ${role}`
      }
    });

  } catch (error) {
    console.error('Update member role error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'UPDATE_MEMBER_ROLE_ERROR',
        message: 'Napaka pri spreminjanju vloge člana'
      }
    });
  }
});

// =============================================================================
// DELETE /households/:id/members/:userId - Remove Member
// =============================================================================

router.delete('/:id/members/:userId', requireHouseholdAccess, requirePermission('manage_members'), 
  async (req, res) => {
  try {
    const householdId = req.params.id;
    const userId = req.params.userId;

    // Check if member exists
    const member = await queryOne(`
      SELECT 
        hm.membership_id,
        u.first_name,
        u.last_name
      FROM household_members hm
      JOIN users u ON hm.user_id = u.user_id
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `, [householdId, userId]);

    if (!member) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'MEMBER_NOT_FOUND',
          message: 'Član ni najden'
        }
      });
    }

    // Don't allow removing self
    if (parseInt(userId) === req.user.userId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CANNOT_REMOVE_SELF',
          message: 'Ne morete odstraniti sebe'
        }
      });
    }

    // Remove member (soft delete)
    await query(`
      UPDATE household_members 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE membership_id = ?
    `, [member.membership_id]);

    res.json({
      success: true,
      data: {
        message: `Član ${member.first_name} ${member.last_name} je bil uspešno odstranjen`
      }
    });

  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'REMOVE_MEMBER_ERROR',
        message: 'Napaka pri odstranjevanju člana'
      }
    });
  }
});

// =============================================================================
// POST /households/:id/leave - Leave Household
// =============================================================================

router.post('/:id/leave', requireHouseholdAccess, async (req, res) => {
  try {
    const householdId = req.params.id;

    // Check if user is household creator
    const household = await queryOne(`
      SELECT created_by_user_id FROM households 
      WHERE household_id = ?
    `, [householdId]);

    if (household && household.created_by_user_id === req.user.userId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CREATOR_CANNOT_LEAVE',
          message: 'Ustvarjalec doma ne more zapustiti doma. Prenesete lahko lastništvo ali izbrišete dom.'
        }
      });
    }

    // Remove user from household
    await query(`
      UPDATE household_members 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE household_id = ? AND user_id = ?
    `, [householdId, req.user.userId]);

    res.json({
      success: true,
      data: {
        message: 'Uspešno ste zapustili dom'
      }
    });

  } catch (error) {
    console.error('Leave household error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'LEAVE_HOUSEHOLD_ERROR',
        message: 'Napaka pri zapuščanju doma'
      }
    });
  }
});

// =============================================================================
// DELETE /households/:id - Delete Household
// =============================================================================

router.delete('/:id', requireHouseholdAccess, requirePermission('manage_household'), 
  async (req, res) => {
  try {
    const householdId = req.params.id;

    // Soft delete household and all related data
    await query(`
      UPDATE households 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE household_id = ?
    `, [householdId]);

    // Deactivate all memberships
    await query(`
      UPDATE household_members 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE household_id = ?
    `, [householdId]);

    // Deactivate all tasks
    await query(`
      UPDATE tasks 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE household_id = ?
    `, [householdId]);

    // Deactivate all rewards
    await query(`
      UPDATE rewards 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE household_id = ?
    `, [householdId]);

    res.json({
      success: true,
      data: {
        message: 'Dom je bil uspešno izbrisan'
      }
    });

  } catch (error) {
    console.error('Delete household error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'DELETE_HOUSEHOLD_ERROR',
        message: 'Napaka pri brisanju doma'
      }
    });
  }
});

module.exports = router;