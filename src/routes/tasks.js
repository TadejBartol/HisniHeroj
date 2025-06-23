// =============================================================================
// Task Management Routes
// =============================================================================

const express = require('express');
const { query, queryOne } = require('../models/database');
const { authenticate, requireHouseholdAccess, checkPermission } = require('../middleware/auth');
const { validate, taskSchemas } = require('../middleware/validation');

const router = express.Router();

// Apply authentication to all task routes
router.use(authenticate);

// =============================================================================
// GET /tasks/categories - Get Task Categories
// =============================================================================

router.get('/categories', async (req, res) => {
  try {
    const categories = await query(`
      SELECT 
        category_id,
        name,
        description,
        icon,
        color,
        is_active
      FROM task_categories 
      WHERE is_active = 1
      ORDER BY name
    `);

    res.json({
      success: true,
      data: {
        categories
      }
    });

  } catch (error) {
    console.error('Get task categories error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_CATEGORIES_ERROR',
        message: 'Napaka pri pridobivanju kategorij'
      }
    });
  }
});

// =============================================================================
// GET /tasks - Get Tasks (with filtering)
// =============================================================================

router.get('/', async (req, res) => {
  try {
    const { 
      household_id, 
      category_id, 
      frequency,
      is_active = '1',
      created_by,
      limit = '50',
      offset = '0'
    } = req.query;

    // Build WHERE clause
    let whereConditions = ['t.is_active = ?'];
    let whereParams = [parseInt(is_active)];

    if (household_id) {
      // Check if user has access to this household
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

      whereConditions.push('t.household_id = ?');
      whereParams.push(parseInt(household_id));
    }

    if (category_id) {
      whereConditions.push('t.category_id = ?');
      whereParams.push(parseInt(category_id));
    }

    if (frequency) {
      whereConditions.push('t.frequency = ?');
      whereParams.push(frequency);
    }

    if (created_by) {
      whereConditions.push('t.created_by_user_id = ?');
      whereParams.push(parseInt(created_by));
    }

    const whereClause = whereConditions.join(' AND ');

    // Get tasks with all related data
    const tasks = await query(`
      SELECT 
        t.task_id,
        t.title,
        t.description,
        t.category_id,
        t.difficulty_minutes,
        t.frequency,
        t.requires_photo,
        t.auto_assign,
        t.created_at,
        t.updated_at,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        -- Household info
        h.name as household_name,
        -- Creator info
        creator.first_name as created_by_first_name,
        creator.last_name as created_by_last_name,
        -- Assignment stats
        (SELECT COUNT(*) FROM task_assignments ta 
         WHERE ta.task_id = t.task_id AND ta.is_active = 1) as active_assignments,
        (SELECT COUNT(*) FROM task_completions tc 
         WHERE tc.task_id = t.task_id) as total_completions,
        -- Next assignment (for recurring tasks)
        (SELECT MIN(ta.due_date) FROM task_assignments ta 
         WHERE ta.task_id = t.task_id AND ta.is_active = 1 AND ta.status = 'pending') as next_due_date
      FROM tasks t
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN households h ON t.household_id = h.household_id
      JOIN users creator ON t.created_by_user_id = creator.user_id
      WHERE ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `, [...whereParams, parseInt(limit), parseInt(offset)]);

    // Get total count for pagination
    const totalResult = await queryOne(`
      SELECT COUNT(*) as total
      FROM tasks t
      WHERE ${whereClause}
    `, whereParams);

    res.json({
      success: true,
      data: {
        tasks,
        pagination: {
          total: totalResult.total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: totalResult.total > (parseInt(offset) + parseInt(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_TASKS_ERROR',
        message: 'Napaka pri pridobivanju nalog'
      }
    });
  }
});

// =============================================================================
// GET /tasks/:id - Get Single Task
// =============================================================================

router.get('/:id', async (req, res) => {
  try {
    const taskId = req.params.id;

    const task = await queryOne(`
      SELECT 
        t.task_id,
        t.household_id,
        t.title,
        t.description,
        t.category_id,
        t.difficulty_minutes,
        t.frequency,
        t.requires_photo,
        t.auto_assign,
        t.created_at,
        t.updated_at,
        t.created_by_user_id,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        -- Household info
        h.name as household_name,
        -- Creator info
        creator.first_name as created_by_first_name,
        creator.last_name as created_by_last_name,
        -- User's household membership
        hm.role as user_role
      FROM tasks t
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN households h ON t.household_id = h.household_id
      JOIN users creator ON t.created_by_user_id = creator.user_id
      JOIN household_members hm ON t.household_id = hm.household_id
      WHERE t.task_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND t.is_active = 1
    `, [taskId, req.user.userId]);

    if (!task) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    // Get recent assignments
    const recentAssignments = await query(`
      SELECT 
        ta.assignment_id,
        ta.assigned_to_user_id,
        ta.due_date,
        ta.status,
        ta.created_at,
        -- Assigned user info
        u.first_name as assigned_to_first_name,
        u.last_name as assigned_to_last_name,
        u.profile_image as assigned_to_profile_image
      FROM task_assignments ta
      JOIN users u ON ta.assigned_to_user_id = u.user_id
      WHERE ta.task_id = ? AND ta.is_active = 1
      ORDER BY ta.created_at DESC
      LIMIT 10
    `, [taskId]);

    // Get recent completions
    const recentCompletions = await query(`
      SELECT 
        tc.completion_id,
        tc.completed_by_user_id,
        tc.completed_at,
        tc.points_earned,
        tc.comment,
        tc.proof_image,
        -- Completed by user info
        u.first_name as completed_by_first_name,
        u.last_name as completed_by_last_name,
        u.profile_image as completed_by_profile_image
      FROM task_completions tc
      JOIN users u ON tc.completed_by_user_id = u.user_id
      WHERE tc.task_id = ?
      ORDER BY tc.completed_at DESC
      LIMIT 10
    `, [taskId]);

    res.json({
      success: true,
      data: {
        task,
        recent_assignments: recentAssignments,
        recent_completions: recentCompletions
      }
    });

  } catch (error) {
    console.error('Get task error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_TASK_ERROR',
        message: 'Napaka pri pridobivanju naloge'
      }
    });
  }
});

// =============================================================================
// POST /tasks - Create New Task
// =============================================================================

router.post('/', requireHouseholdAccess, checkPermission('create_tasks'), 
  validate(taskSchemas.create), async (req, res) => {
  try {
    const {
      household_id,
      title,
      description,
      category_id,
      difficulty_minutes,
      frequency,
      requires_photo = false,
      auto_assign = false
    } = req.body;

    // Verify category exists
    const category = await queryOne(
      'SELECT category_id FROM task_categories WHERE category_id = ? AND is_active = 1',
      [category_id]
    );

    if (!category) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_CATEGORY',
          message: 'Izbrana kategorija ni veljavna'
        }
      });
    }

    // Create task
    const taskResult = await query(`
      INSERT INTO tasks (
        household_id, title, description, category_id, 
        difficulty_minutes, frequency, requires_photo, auto_assign, 
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      household_id, title, description, category_id,
      difficulty_minutes, frequency, requires_photo, auto_assign,
      req.user.userId
    ]);

    const taskId = taskResult.insertId;

    // Fetch created task with all details
    const task = await queryOne(`
      SELECT 
        t.task_id,
        t.household_id,
        t.title,
        t.description,
        t.category_id,
        t.difficulty_minutes,
        t.frequency,
        t.requires_photo,
        t.auto_assign,
        t.created_at,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        -- Household info
        h.name as household_name
      FROM tasks t
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN households h ON t.household_id = h.household_id
      WHERE t.task_id = ?
    `, [taskId]);

    res.status(201).json({
      success: true,
      data: {
        task,
        message: 'Naloga je bila uspešno ustvarjena'
      }
    });

  } catch (error) {
    console.error('Create task error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'CREATE_TASK_ERROR',
        message: 'Napaka pri ustvarjanju naloge'
      }
    });
  }
});

// =============================================================================
// PUT /tasks/:id - Update Task
// =============================================================================

router.put('/:id', requireHouseholdAccess, checkPermission('create_tasks'), 
  validate(taskSchemas.update), async (req, res) => {
  try {
    const taskId = req.params.id;
    const {
      title,
      description,
      category_id,
      difficulty_minutes,
      frequency,
      requires_photo,
      auto_assign
    } = req.body;

    // Check if task exists and user has access
    const existingTask = await queryOne(`
      SELECT 
        t.task_id,
        t.household_id,
        hm.role as user_role
      FROM tasks t
      JOIN household_members hm ON t.household_id = hm.household_id
      WHERE t.task_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND t.is_active = 1
    `, [taskId, req.user.userId]);

    if (!existingTask) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    // Verify category exists if provided
    if (category_id) {
      const category = await queryOne(
        'SELECT category_id FROM task_categories WHERE category_id = ? AND is_active = 1',
        [category_id]
      );

      if (!category) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_CATEGORY',
            message: 'Izbrana kategorija ni veljavna'
          }
        });
      }
    }

    // Update task
    await query(`
      UPDATE tasks 
      SET 
        title = ?, 
        description = ?, 
        category_id = ?, 
        difficulty_minutes = ?, 
        frequency = ?, 
        requires_photo = ?, 
        auto_assign = ?,
        updated_at = NOW()
      WHERE task_id = ?
    `, [
      title, description, category_id, difficulty_minutes, 
      frequency, requires_photo, auto_assign, taskId
    ]);

    // Fetch updated task
    const task = await queryOne(`
      SELECT 
        t.task_id,
        t.household_id,
        t.title,
        t.description,
        t.category_id,
        t.difficulty_minutes,
        t.frequency,
        t.requires_photo,
        t.auto_assign,
        t.created_at,
        t.updated_at,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        -- Household info
        h.name as household_name
      FROM tasks t
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN households h ON t.household_id = h.household_id
      WHERE t.task_id = ?
    `, [taskId]);

    res.json({
      success: true,
      data: {
        task,
        message: 'Naloga je bila uspešno posodobljena'
      }
    });

  } catch (error) {
    console.error('Update task error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'UPDATE_TASK_ERROR',
        message: 'Napaka pri posodabljanju naloge'
      }
    });
  }
});

// =============================================================================
// DELETE /tasks/:id - Delete Task
// =============================================================================

router.delete('/:id', requireHouseholdAccess, checkPermission('create_tasks'), 
  async (req, res) => {
  try {
    const taskId = req.params.id;

    // Check if task exists and user has access
    const existingTask = await queryOne(`
      SELECT 
        t.task_id,
        t.title,
        t.household_id,
        hm.role as user_role
      FROM tasks t
      JOIN household_members hm ON t.household_id = hm.household_id
      WHERE t.task_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND t.is_active = 1
    `, [taskId, req.user.userId]);

    if (!existingTask) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    // Soft delete task
    await query(`
      UPDATE tasks 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE task_id = ?
    `, [taskId]);

    // Deactivate all active assignments
    await query(`
      UPDATE task_assignments 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE task_id = ? AND is_active = 1
    `, [taskId]);

    res.json({
      success: true,
      data: {
        message: `Naloga "${existingTask.title}" je bila uspešno izbrisana`
      }
    });

  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'DELETE_TASK_ERROR',
        message: 'Napaka pri brisanju naloge'
      }
    });
  }
});

// =============================================================================
// GET /tasks/:id/stats - Get Task Statistics
// =============================================================================

router.get('/:id/stats', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { period = '30' } = req.query; // days

    // Check if task exists and user has access
    const taskExists = await queryOne(`
      SELECT t.task_id FROM tasks t
      JOIN household_members hm ON t.household_id = hm.household_id
      WHERE t.task_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND t.is_active = 1
    `, [taskId, req.user.userId]);

    if (!taskExists) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    // Basic task stats
    const basicStats = await queryOne(`
      SELECT 
        COUNT(DISTINCT tc.completion_id) as total_completions,
        COUNT(DISTINCT CASE WHEN tc.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY) THEN tc.completion_id END) as recent_completions,
        COUNT(DISTINCT tc.completed_by_user_id) as unique_completers,
        COALESCE(SUM(tc.points_earned), 0) as total_points_awarded,
        COALESCE(AVG(tc.points_earned), 0) as avg_points_per_completion,
        -- Assignment stats
        COUNT(DISTINCT ta.assignment_id) as total_assignments,
        COUNT(DISTINCT CASE WHEN ta.status = 'pending' AND ta.is_active = 1 THEN ta.assignment_id END) as pending_assignments,
        COUNT(DISTINCT CASE WHEN ta.status = 'overdue' AND ta.is_active = 1 THEN ta.assignment_id END) as overdue_assignments
      FROM tasks t
      LEFT JOIN task_completions tc ON t.task_id = tc.task_id
      LEFT JOIN task_assignments ta ON t.task_id = ta.task_id
      WHERE t.task_id = ?
    `, [period, taskId]);

    // Completion by user
    const completionsByUser = await query(`
      SELECT 
        u.user_id,
        u.first_name,
        u.last_name,
        u.profile_image,
        COUNT(tc.completion_id) as completions,
        COALESCE(SUM(tc.points_earned), 0) as points_earned,
        MAX(tc.completed_at) as last_completed
      FROM task_completions tc
      JOIN users u ON tc.completed_by_user_id = u.user_id
      WHERE tc.task_id = ? AND tc.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY u.user_id, u.first_name, u.last_name, u.profile_image
      ORDER BY completions DESC, points_earned DESC
    `, [taskId, period]);

    // Completion timeline (last 30 days)
    const completionTimeline = await query(`
      SELECT 
        DATE(tc.completed_at) as completion_date,
        COUNT(tc.completion_id) as completions,
        SUM(tc.points_earned) as points_earned
      FROM task_completions tc
      WHERE tc.task_id = ? AND tc.completed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(tc.completed_at)
      ORDER BY completion_date
    `, [taskId]);

    res.json({
      success: true,
      data: {
        basic_stats: basicStats,
        completions_by_user: completionsByUser,
        completion_timeline: completionTimeline,
        period_days: parseInt(period)
      }
    });

  } catch (error) {
    console.error('Get task stats error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_TASK_STATS_ERROR',
        message: 'Napaka pri pridobivanju statistik naloge'
      }
    });
  }
});

module.exports = router;