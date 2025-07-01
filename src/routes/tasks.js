// =============================================================================
// Task Management Routes
// =============================================================================

const express = require('express');
const { query, queryOne } = require('../models/database');
const { requireHouseholdAccess, requirePermission } = require('../middleware/auth');
const { validate, taskSchemas } = require('../middleware/validation');

const router = express.Router();

// =============================================================================
// GET /tasks/categories - Get Task Categories
// =============================================================================

router.get('/categories', async (req, res) => {
  try {
    const { household_id } = req.query;

    let where = 'is_active = 1';
    const params = [];

    if (household_id) {
      where += ' AND household_id = ?';
      params.push(parseInt(household_id));
    }

    const categories = await query(
      `SELECT 
        category_id,
        household_id,
        name,
        description,
        icon,
        color,
        is_active
      FROM task_categories 
      WHERE ${where}
      ORDER BY name`,
      params
    );

    res.json({ success: true, data: { categories } });

  } catch (error) {
    console.error('Get task categories error:', error);
    res.status(500).json({ success: false, error: { code: 'GET_CATEGORIES_ERROR', message: 'Napaka pri pridobivanju kategorij' } });
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
        tc.completed_by,
        tc.completed_at,
        tc.points_earned,
        tc.comment,
        tc.proof_image,
        -- Completed by user info
        u.first_name as completed_by_first_name,
        u.last_name as completed_by_last_name,
        u.profile_image as completed_by_profile_image
      FROM task_completions tc
      JOIN users u ON tc.completed_by = u.user_id
      JOIN task_assignments ta ON tc.assignment_id = ta.assignment_id
      WHERE ta.task_id = ?
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

router.post('/', validate(taskSchemas.create), async (req, res) => {
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

    // Verify access and permissions
    const hasAccess = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role,
        hm.can_create_tasks
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

    // Check can_create_tasks permission
    if (hasAccess.role !== 'owner' && hasAccess.role !== 'admin' && !hasAccess.can_create_tasks) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Nimate dovoljenj za ustvarjanje opravil'
        }
      });
    }

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

    // Handle cycle_users list if provided and auto_assign is true
    const { cycle_users } = req.body;
    if (auto_assign && Array.isArray(cycle_users) && cycle_users.length) {
      // Ensure helper table exists
      await query(`CREATE TABLE IF NOT EXISTS task_cycle_users (
        task_id INT NOT NULL,
        user_id INT NOT NULL,
        position INT DEFAULT 0,
        PRIMARY KEY (task_id, user_id),
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

      // Remove previous (should be none for new task) and insert
      await query('DELETE FROM task_cycle_users WHERE task_id = ?', [taskId]);
      for (let i = 0; i < cycle_users.length; i++) {
        const uid = cycle_users[i];
        await query('INSERT INTO task_cycle_users (task_id, user_id, position) VALUES (?,?,?)', [taskId, uid, i]);
      }
    }

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

router.put('/:id', validate(taskSchemas.update), async (req, res) => {
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

    // Check if task exists and get household_id
    const existingTask = await queryOne(`
      SELECT 
        t.task_id,
        t.household_id
      FROM tasks t
      WHERE t.task_id = ? AND t.is_active = 1
    `, [taskId]);

    if (!existingTask) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    // Verify access and permissions
    const hasAccess = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role,
        hm.can_create_tasks
      FROM household_members hm
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `, [existingTask.household_id, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega doma'
        }
      });
    }

    // Check can_create_tasks permission
    if (hasAccess.role !== 'owner' && hasAccess.role !== 'admin' && !hasAccess.can_create_tasks) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Nimate dovoljenj za urejanje opravil'
        }
      });
    }

    // Task existence and access already verified above

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

    // Normalize undefined to null so mysql2 binding accepts parameters
    const normalizedParams = [title, description, category_id, difficulty_minutes, frequency, requires_photo, auto_assign]
      .map(v => v === undefined ? null : v);

    const [nTitle, nDesc, nCat, nDiff, nFreq, nReqPhoto, nAuto] = normalizedParams;

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
    `, [nTitle, nDesc, nCat, nDiff, nFreq, nReqPhoto, nAuto, taskId]);

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

    // If cycle_users provided, sync table
    if (req.body.cycle_users) {
      await query(`CREATE TABLE IF NOT EXISTS task_cycle_users (
        task_id INT NOT NULL,
        user_id INT NOT NULL,
        position INT DEFAULT 0,
        PRIMARY KEY (task_id, user_id),
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

      await query('DELETE FROM task_cycle_users WHERE task_id = ?', [taskId]);
      if (Array.isArray(req.body.cycle_users) && req.body.cycle_users.length) {
        for (let i = 0; i < req.body.cycle_users.length; i++) {
          const uid = req.body.cycle_users[i];
          await query('INSERT INTO task_cycle_users (task_id, user_id, position) VALUES (?,?,?)', [taskId, uid, i]);
        }
      }
    }

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

router.delete('/:id', async (req, res) => {
  try {
    const taskId = req.params.id;

    // Check if task exists and get household_id
    const taskInfo = await queryOne(`
      SELECT 
        t.task_id,
        t.title,
        t.household_id
      FROM tasks t
      WHERE t.task_id = ? AND t.is_active = 1
    `, [taskId]);

    if (!taskInfo) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    // Verify access and permissions
    const hasAccess = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role,
        hm.can_create_tasks
      FROM household_members hm
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `, [taskInfo.household_id, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega doma'
        }
      });
    }

    // Check can_create_tasks permission
    if (hasAccess.role !== 'owner' && hasAccess.role !== 'admin' && !hasAccess.can_create_tasks) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Nimate dovoljenj za brisanje opravil'
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
        message: `Naloga "${taskInfo.title}" je bila uspešno izbrisana`
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
        COUNT(DISTINCT tc.completed_by) as unique_completers,
        COALESCE(SUM(tc.points_earned), 0) as total_points_awarded,
        COALESCE(AVG(tc.points_earned), 0) as avg_points_per_completion,
        -- Assignment stats
        COUNT(DISTINCT ta.assignment_id) as total_assignments,
        COUNT(DISTINCT CASE WHEN ta.status = 'pending' AND ta.is_active = 1 THEN ta.assignment_id END) as pending_assignments,
        COUNT(DISTINCT CASE WHEN ta.status = 'overdue' AND ta.is_active = 1 THEN ta.assignment_id END) as overdue_assignments
              FROM tasks t
        LEFT JOIN task_assignments ta ON t.task_id = ta.task_id
        LEFT JOIN task_completions tc ON ta.assignment_id = tc.assignment_id
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
      JOIN users u ON tc.completed_by = u.user_id
      JOIN task_assignments ta ON tc.assignment_id = ta.assignment_id
      WHERE ta.task_id = ? AND tc.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
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
      JOIN task_assignments ta ON tc.assignment_id = ta.assignment_id
      WHERE ta.task_id = ? AND tc.completed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
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

// =============================================================================
// POST /tasks/categories - Create Category
// =============================================================================

router.post('/categories', async (req, res) => {
  try {
    const { household_id, name, description = '', color = '#3498db', icon = 'home' } = req.body;

    if (!household_id || !name) {
      return res.status(400).json({ success:false, error:{ code:'INVALID_INPUT', message:'household_id in name sta obvezna' }});
    }

    // Verify membership + permissions
    const member = await queryOne(`
      SELECT hm.role, hm.can_create_tasks
      FROM household_members hm
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `,[household_id, req.user.userId]);

    if (!member) {
      return res.status(403).json({ success:false, error:{ code:'HOUSEHOLD_ACCESS_DENIED', message:'Nimate dostopa do tega doma' }});
    }

    if (member.role !== 'owner' && member.role !== 'admin' && !member.can_create_tasks) {
      return res.status(403).json({ success:false, error:{ code:'INSUFFICIENT_PERMISSIONS', message:'Nimate dovoljenj za ustvarjanje kategorij' }});
    }

    // Insert category
    const result = await query(`
      INSERT INTO task_categories (household_id, name, description, color, icon, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `,[household_id, name, description, color, icon]);

    const category = await queryOne('SELECT * FROM task_categories WHERE category_id = ?', [result.insertId]);

    res.status(201).json({ success:true, data:{ category, message:'Kategorija uspešno ustvarjena' }});

  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ success:false, error:{ code:'CREATE_CATEGORY_ERROR', message:'Napaka pri ustvarjanju kategorije' }});
  }
});

// =============================================================================
// PUT /tasks/categories/:id - Update Category
// =============================================================================

router.put('/categories/:id', async (req,res)=>{
  try {
    const categoryId = req.params.id;
    const { name, description, color, icon, is_active } = req.body;

    // Fetch category & household
    const category = await queryOne('SELECT * FROM task_categories WHERE category_id = ?', [categoryId]);
    if (!category) {
      return res.status(404).json({ success:false, error:{ code:'CATEGORY_NOT_FOUND', message:'Kategorija ni najdena' }});
    }

    // Verify permissions
    const member = await queryOne(`
      SELECT hm.role, hm.can_create_tasks
      FROM household_members hm
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
    `,[category.household_id, req.user.userId]);

    if (!member) return res.status(403).json({ success:false, error:{ code:'HOUSEHOLD_ACCESS_DENIED', message:'Nimate dostopa do tega doma' }});
    if (member.role !== 'owner' && member.role !== 'admin' && !member.can_create_tasks) {
      return res.status(403).json({ success:false, error:{ code:'INSUFFICIENT_PERMISSIONS', message:'Nimate dovoljenj za urejanje kategorij' }});
    }

    await query(`
      UPDATE task_categories SET 
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        color = COALESCE(?, color),
        icon = COALESCE(?, icon),
        is_active = COALESCE(?, is_active),
        updated_at = NOW()
      WHERE category_id = ?
    `,[name, description, color, icon, is_active, categoryId]);

    const updated = await queryOne('SELECT * FROM task_categories WHERE category_id = ?', [categoryId]);
    res.json({ success:true, data:{ category: updated, message:'Kategorija posodobljena' }});

  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ success:false, error:{ code:'UPDATE_CATEGORY_ERROR', message:'Napaka pri posodabljanju kategorije' }});
  }
});

module.exports = router;