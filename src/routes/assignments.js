// =============================================================================
// Task Assignment Routes
// =============================================================================

const express = require('express');
const { query, queryOne, beginTransaction, commitTransaction, rollbackTransaction } = require('../models/database');
const { authenticate, requireHouseholdAccess, checkPermission } = require('../middleware/auth');
const { validate, assignmentSchemas } = require('../middleware/validation');

const router = express.Router();

// Apply authentication to all assignment routes
router.use(authenticate);

// =============================================================================
// GET /assignments - Get User's Assignments
// =============================================================================

router.get('/', async (req, res) => {
  try {
    const { 
      status = 'pending', 
      household_id,
      limit = '50',
      offset = '0'
    } = req.query;

    // Build WHERE clause
    let whereConditions = ['ta.assigned_to_user_id = ?', 'ta.is_active = 1'];
    let whereParams = [req.user.userId];

    if (status && status !== 'all') {
      whereConditions.push('ta.status = ?');
      whereParams.push(status);
    }

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

      whereConditions.push('t.household_id = ?');
      whereParams.push(parseInt(household_id));
    }

    const whereClause = whereConditions.join(' AND ');

    // Get assignments
    const assignments = await query(`
      SELECT 
        ta.assignment_id,
        ta.task_id,
        ta.assigned_to_user_id,
        ta.due_date,
        ta.status,
        ta.created_at,
        ta.updated_at,
        -- Task info
        t.title as task_title,
        t.description as task_description,
        t.difficulty_minutes,
        t.requires_photo,
        t.household_id,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        -- Household info
        h.name as household_name,
        -- Assignment creator info
        creator.first_name as assigned_by_first_name,
        creator.last_name as assigned_by_last_name,
        -- Days until due
        DATEDIFF(ta.due_date, NOW()) as days_until_due,
        -- Is overdue
        CASE WHEN ta.due_date < NOW() AND ta.status = 'pending' THEN 1 ELSE 0 END as is_overdue
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN households h ON t.household_id = h.household_id
      LEFT JOIN users creator ON ta.assigned_by_user_id = creator.user_id
      WHERE ${whereClause} AND t.is_active = 1
      ORDER BY 
        CASE WHEN ta.status = 'overdue' THEN 1 
             WHEN ta.status = 'pending' THEN 2 
             ELSE 3 END,
        ta.due_date ASC
      LIMIT ? OFFSET ?
    `, [...whereParams, parseInt(limit), parseInt(offset)]);

    // Get total count
    const totalResult = await queryOne(`
      SELECT COUNT(*) as total
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      WHERE ${whereClause} AND t.is_active = 1
    `, whereParams);

    res.json({
      success: true,
      data: {
        assignments,
        pagination: {
          total: totalResult.total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: totalResult.total > (parseInt(offset) + parseInt(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get assignments error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_ASSIGNMENTS_ERROR',
        message: 'Napaka pri pridobivanju nalog'
      }
    });
  }
});

// =============================================================================
// GET /assignments/today - Get Today's Assignments
// =============================================================================

router.get('/today', async (req, res) => {
  try {
    const assignments = await query(`
      SELECT 
        ta.assignment_id,
        ta.task_id,
        ta.due_date,
        ta.status,
        -- Task info
        t.title as task_title,
        t.description as task_description,
        t.difficulty_minutes,
        t.requires_photo,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        -- Household info
        h.name as household_name,
        -- Is overdue
        CASE WHEN ta.due_date < NOW() AND ta.status = 'pending' THEN 1 ELSE 0 END as is_overdue
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN households h ON t.household_id = h.household_id
      WHERE ta.assigned_to_user_id = ? 
        AND ta.is_active = 1 
        AND t.is_active = 1
        AND (
          (ta.status = 'pending' AND DATE(ta.due_date) <= CURDATE()) OR
          ta.status = 'overdue'
        )
      ORDER BY 
        CASE WHEN ta.status = 'overdue' THEN 1 ELSE 2 END,
        ta.due_date ASC
    `, [req.user.userId]);

    res.json({
      success: true,
      data: {
        assignments,
        summary: {
          total: assignments.length,
          overdue: assignments.filter(a => a.is_overdue).length,
          due_today: assignments.filter(a => !a.is_overdue).length
        }
      }
    });

  } catch (error) {
    console.error('Get today assignments error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_TODAY_ASSIGNMENTS_ERROR',
        message: 'Napaka pri pridobivanju današnjih nalog'
      }
    });
  }
});

// =============================================================================
// GET /assignments/:id - Get Single Assignment
// =============================================================================

router.get('/:id', async (req, res) => {
  try {
    const assignmentId = req.params.id;

    const assignment = await queryOne(`
      SELECT 
        ta.assignment_id,
        ta.task_id,
        ta.assigned_to_user_id,
        ta.assigned_by_user_id,
        ta.due_date,
        ta.status,
        ta.created_at,
        ta.updated_at,
        -- Task info
        t.title as task_title,
        t.description as task_description,
        t.difficulty_minutes,
        t.requires_photo,
        t.household_id,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        -- Household info
        h.name as household_name,
        -- Assigned by user info
        assigner.first_name as assigned_by_first_name,
        assigner.last_name as assigned_by_last_name,
        -- Days until due
        DATEDIFF(ta.due_date, NOW()) as days_until_due,
        -- Is overdue
        CASE WHEN ta.due_date < NOW() AND ta.status = 'pending' THEN 1 ELSE 0 END as is_overdue
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN households h ON t.household_id = h.household_id
      LEFT JOIN users assigner ON ta.assigned_by_user_id = assigner.user_id
      WHERE ta.assignment_id = ? AND ta.assigned_to_user_id = ? AND ta.is_active = 1
    `, [assignmentId, req.user.userId]);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'ASSIGNMENT_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    res.json({
      success: true,
      data: {
        assignment
      }
    });

  } catch (error) {
    console.error('Get assignment error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_ASSIGNMENT_ERROR',
        message: 'Napaka pri pridobivanju naloge'
      }
    });
  }
});

// =============================================================================
// POST /assignments - Create Task Assignment
// =============================================================================

router.post('/', requireHouseholdAccess, checkPermission('assign_tasks'), 
  validate(assignmentSchemas.create), async (req, res) => {
  try {
    const {
      task_id,
      assigned_to_user_id,
      due_date
    } = req.body;

    // Verify task exists and user has access
    const task = await queryOne(`
      SELECT 
        t.task_id,
        t.title,
        t.household_id,
        hm.role as user_role
      FROM tasks t
      JOIN household_members hm ON t.household_id = hm.household_id
      WHERE t.task_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND t.is_active = 1
    `, [task_id, req.user.userId]);

    if (!task) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    // Verify assigned user is household member
    const assignedUser = await queryOne(`
      SELECT 
        hm.user_id,
        u.first_name,
        u.last_name
      FROM household_members hm
      JOIN users u ON hm.user_id = u.user_id
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND u.is_active = 1
    `, [task.household_id, assigned_to_user_id]);

    if (!assignedUser) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ASSIGNED_USER',
          message: 'Izbrani uporabnik ni član doma'
        }
      });
    }

    // Check for existing active assignment
    const existingAssignment = await queryOne(`
      SELECT assignment_id FROM task_assignments 
      WHERE task_id = ? AND assigned_to_user_id = ? AND is_active = 1 AND status = 'pending'
    `, [task_id, assigned_to_user_id]);

    if (existingAssignment) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ASSIGNMENT_ALREADY_EXISTS',
          message: 'Uporabnik ima že dodeljeno to nalogo'
        }
      });
    }

    // Create assignment
    const assignmentResult = await query(`
      INSERT INTO task_assignments (
        task_id, assigned_to_user_id, assigned_by_user_id, 
        due_date, status, created_at
      ) VALUES (?, ?, ?, ?, 'pending', NOW())
    `, [task_id, assigned_to_user_id, req.user.userId, due_date]);

    const assignmentId = assignmentResult.insertId;

    // Fetch created assignment
    const assignment = await queryOne(`
      SELECT 
        ta.assignment_id,
        ta.task_id,
        ta.assigned_to_user_id,
        ta.due_date,
        ta.status,
        ta.created_at,
        -- Task info
        t.title as task_title,
        -- Assigned user info
        u.first_name as assigned_to_first_name,
        u.last_name as assigned_to_last_name
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      JOIN users u ON ta.assigned_to_user_id = u.user_id
      WHERE ta.assignment_id = ?
    `, [assignmentId]);

    res.status(201).json({
      success: true,
      data: {
        assignment,
        message: `Naloga "${task.title}" je bila dodeljena uporabniku ${assignedUser.first_name} ${assignedUser.last_name}`
      }
    });

  } catch (error) {
    console.error('Create assignment error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'CREATE_ASSIGNMENT_ERROR',
        message: 'Napaka pri dodeljevanju naloge'
      }
    });
  }
});

// =============================================================================
// POST /assignments/bulk - Bulk Create Assignments
// =============================================================================

router.post('/bulk', requireHouseholdAccess, checkPermission('assign_tasks'), 
  validate(assignmentSchemas.bulkCreate), async (req, res) => {
  let connection;
  
  try {
    const { assignments } = req.body;

    // Begin transaction
    connection = await beginTransaction();

    const createdAssignments = [];

    for (const assignment of assignments) {
      const { task_id, assigned_to_user_id, due_date } = assignment;

      // Verify task exists and user has access
      const task = await queryOne(`
        SELECT t.task_id, t.title, t.household_id
        FROM tasks t
        JOIN household_members hm ON t.household_id = hm.household_id
        WHERE t.task_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND t.is_active = 1
      `, [task_id, req.user.userId]);

      if (!task) continue; // Skip invalid tasks

      // Verify assigned user is household member
      const assignedUser = await queryOne(`
        SELECT hm.user_id
        FROM household_members hm
        WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
      `, [task.household_id, assigned_to_user_id]);

      if (!assignedUser) continue; // Skip invalid users

      // Check for existing active assignment
      const existingAssignment = await queryOne(`
        SELECT assignment_id FROM task_assignments 
        WHERE task_id = ? AND assigned_to_user_id = ? AND is_active = 1 AND status = 'pending'
      `, [task_id, assigned_to_user_id]);

      if (existingAssignment) continue; // Skip existing assignments

      // Create assignment
      const assignmentResult = await connection.execute(`
        INSERT INTO task_assignments (
          task_id, assigned_to_user_id, assigned_by_user_id, 
          due_date, status, created_at
        ) VALUES (?, ?, ?, ?, 'pending', NOW())
      `, [task_id, assigned_to_user_id, req.user.userId, due_date]);

      createdAssignments.push({
        assignment_id: assignmentResult[0].insertId,
        task_id,
        assigned_to_user_id,
        due_date,
        task_title: task.title
      });
    }

    // Commit transaction
    await commitTransaction(connection);

    res.status(201).json({
      success: true,
      data: {
        assignments: createdAssignments,
        message: `Uspešno ustvarjenih ${createdAssignments.length} dodelitev`
      }
    });

  } catch (error) {
    if (connection) {
      await rollbackTransaction(connection);
    }
    
    console.error('Bulk create assignments error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'BULK_CREATE_ASSIGNMENTS_ERROR',
        message: 'Napaka pri množičnem dodeljevanju nalog'
      }
    });
  }
});

// =============================================================================
// PUT /assignments/:id/status - Update Assignment Status
// =============================================================================

router.put('/:id/status', validate(assignmentSchemas.updateStatus), async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const { status } = req.body;

    // Check if assignment exists and user has access
    const assignment = await queryOne(`
      SELECT 
        ta.assignment_id,
        ta.task_id,
        ta.status as current_status,
        ta.assigned_to_user_id,
        t.title as task_title
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      WHERE ta.assignment_id = ? AND ta.assigned_to_user_id = ? AND ta.is_active = 1
    `, [assignmentId, req.user.userId]);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'ASSIGNMENT_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    // Don't allow changing completed assignments
    if (assignment.current_status === 'completed') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ASSIGNMENT_ALREADY_COMPLETED',
          message: 'Naloga je že opravljena'
        }
      });
    }

    // Update assignment status
    await query(`
      UPDATE task_assignments 
      SET 
        status = ?,
        updated_at = NOW()
      WHERE assignment_id = ?
    `, [status, assignmentId]);

    res.json({
      success: true,
      data: {
        message: `Status naloge "${assignment.task_title}" je bil spremenjen na ${status}`
      }
    });

  } catch (error) {
    console.error('Update assignment status error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'UPDATE_ASSIGNMENT_STATUS_ERROR',
        message: 'Napaka pri spreminjanju statusa naloge'
      }
    });
  }
});

// =============================================================================
// DELETE /assignments/:id - Cancel Assignment
// =============================================================================

router.delete('/:id', async (req, res) => {
  try {
    const assignmentId = req.params.id;

    // Check if assignment exists and user has access (either assigned user or assigner)
    const assignment = await queryOne(`
      SELECT 
        ta.assignment_id,
        ta.assigned_to_user_id,
        ta.assigned_by_user_id,
        ta.status,
        t.title as task_title,
        t.household_id
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      WHERE ta.assignment_id = ? AND ta.is_active = 1
    `, [assignmentId]);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'ASSIGNMENT_NOT_FOUND',
          message: 'Naloga ni najdena'
        }
      });
    }

    // Check if user has permission to cancel (either assigned user or has assign_tasks permission)
    const canCancel = assignment.assigned_to_user_id === req.user.userId ||
                      assignment.assigned_by_user_id === req.user.userId;

    if (!canCancel) {
      // Check if user has assign_tasks permission in the household
      const hasPermission = await queryOne(`
        SELECT hm.role FROM household_members hm
        WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1
        AND hm.role IN ('admin', 'moderator')
      `, [assignment.household_id, req.user.userId]);

      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'PERMISSION_DENIED',
            message: 'Nimate dovoljenja za preklic te naloge'
          }
        });
      }
    }

    // Don't allow canceling completed assignments
    if (assignment.status === 'completed') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ASSIGNMENT_ALREADY_COMPLETED',
          message: 'Ne morete preklicati opravljene naloge'
        }
      });
    }

    // Cancel assignment (soft delete)
    await query(`
      UPDATE task_assignments 
      SET 
        is_active = 0,
        updated_at = NOW()
      WHERE assignment_id = ?
    `, [assignmentId]);

    res.json({
      success: true,
      data: {
        message: `Naloga "${assignment.task_title}" je bila preklicana`
      }
    });

  } catch (error) {
    console.error('Cancel assignment error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'CANCEL_ASSIGNMENT_ERROR',
        message: 'Napaka pri preklicu naloge'
      }
    });
  }
});

module.exports = router;