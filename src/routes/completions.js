// =============================================================================
// Task Completion Routes  
// =============================================================================

const express = require('express');
const { query, queryOne, beginTransaction, commitTransaction, rollbackTransaction } = require('../models/database');
const { authenticate } = require('../middleware/auth');
const { validate, completionSchemas } = require('../middleware/validation');
const { uploadSingle } = require('../utils/upload');

const router = express.Router();

// Apply authentication to all completion routes
router.use(authenticate);

// =============================================================================
// GET /completions - Get User's Completions
// =============================================================================

router.get('/', async (req, res) => {
  try {
    const { 
      household_id,
      category_id,
      limit = '50',
      offset = '0',
      period = '30' // days
    } = req.query;

    // Build WHERE clause
    let whereConditions = ['tc.completed_by_user_id = ?'];
    let whereParams = [req.user.userId];

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

    if (category_id) {
      whereConditions.push('t.category_id = ?');
      whereParams.push(parseInt(category_id));
    }

    if (period) {
      whereConditions.push('tc.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
      whereParams.push(parseInt(period));
    }

    const whereClause = whereConditions.join(' AND ');

    // Get completions
    const completions = await query(`
      SELECT 
        tc.completion_id,
        tc.task_id,
        tc.assignment_id,
        tc.completed_at,
        tc.points_earned,
        tc.comment,
        tc.proof_image,
        -- Task info
        t.title as task_title,
        t.description as task_description,
        t.difficulty_minutes,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        -- Household info
        h.name as household_name,
        -- Assignment info (if from assignment)
        ta.due_date as assignment_due_date,
        CASE WHEN ta.due_date < tc.completed_at THEN 1 ELSE 0 END as was_overdue
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN households h ON t.household_id = h.household_id
      LEFT JOIN task_assignments ta ON tc.assignment_id = ta.assignment_id
      WHERE ${whereClause}
      ORDER BY tc.completed_at DESC
      LIMIT ? OFFSET ?
    `, [...whereParams, parseInt(limit), parseInt(offset)]);

    // Get total count
    const totalResult = await queryOne(`
      SELECT COUNT(*) as total
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      WHERE ${whereClause}
    `, whereParams);

    res.json({
      success: true,
      data: {
        completions,
        pagination: {
          total: totalResult.total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: totalResult.total > (parseInt(offset) + parseInt(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get completions error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_COMPLETIONS_ERROR',
        message: 'Napaka pri pridobivanju opravljenih nalog'
      }
    });
  }
});

// =============================================================================
// GET /completions/:id - Get Single Completion
// =============================================================================

router.get('/:id', async (req, res) => {
  try {
    const completionId = req.params.id;

    const completion = await queryOne(`
      SELECT 
        tc.completion_id,
        tc.task_id,
        tc.assignment_id,
        tc.completed_by_user_id,
        tc.completed_at,
        tc.points_earned,
        tc.comment,
        tc.proof_image,
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
        -- Completed by user info
        u.first_name as completed_by_first_name,
        u.last_name as completed_by_last_name,
        u.profile_image as completed_by_profile_image,
        -- Assignment info (if applicable)
        ta.due_date as assignment_due_date,
        ta.assigned_by_user_id,
        assigner.first_name as assigned_by_first_name,
        assigner.last_name as assigned_by_last_name,
        CASE WHEN ta.due_date < tc.completed_at THEN 1 ELSE 0 END as was_overdue
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN households h ON t.household_id = h.household_id
      JOIN users u ON tc.completed_by_user_id = u.user_id
      LEFT JOIN task_assignments ta ON tc.assignment_id = ta.assignment_id
      LEFT JOIN users assigner ON ta.assigned_by_user_id = assigner.user_id
      WHERE tc.completion_id = ?
    `, [completionId]);

    if (!completion) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'COMPLETION_NOT_FOUND',
          message: 'Opravljene naloge ni mogoče najti'
        }
      });
    }

    // Check if user has access (either the completer or household member)
    const hasAccess = completion.completed_by_user_id === req.user.userId ||
                      await queryOne(`
                        SELECT membership_id FROM household_members 
                        WHERE household_id = ? AND user_id = ? AND is_active = 1
                      `, [completion.household_id, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'Nimate dostopa do te opravljene naloge'
        }
      });
    }

    res.json({
      success: true,
      data: {
        completion
      }
    });

  } catch (error) {
    console.error('Get completion error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_COMPLETION_ERROR',
        message: 'Napaka pri pridobivanju opravljene naloge'
      }
    });
  }
});

// =============================================================================
// POST /completions - Complete Task
// =============================================================================

router.post('/', validate(completionSchemas.create), async (req, res) => {
  let connection;
  
  try {
    const {
      task_id,
      assignment_id,
      comment,
      proof_image
    } = req.body;

    // Begin transaction
    connection = await beginTransaction();

    let assignment = null;
    let task = null;

    if (assignment_id) {
      // Complete via assignment
      assignment = await queryOne(`
        SELECT 
          ta.assignment_id,
          ta.task_id,
          ta.assigned_to_user_id,
          ta.due_date,
          ta.status,
          t.title,
          t.difficulty_minutes,
          t.requires_photo,
          t.household_id
        FROM task_assignments ta
        JOIN tasks t ON ta.task_id = t.task_id
        WHERE ta.assignment_id = ? AND ta.assigned_to_user_id = ? AND ta.is_active = 1
      `, [assignment_id, req.user.userId]);

      if (!assignment) {
        await rollbackTransaction(connection);
        return res.status(404).json({
          success: false,
          error: {
            code: 'ASSIGNMENT_NOT_FOUND',
            message: 'Dodeljena naloga ni najdena'
          }
        });
      }

      if (assignment.status === 'completed') {
        await rollbackTransaction(connection);
        return res.status(400).json({
          success: false,
          error: {
            code: 'ASSIGNMENT_ALREADY_COMPLETED',
            message: 'Naloga je že opravljena'
          }
        });
      }

      task = {
        task_id: assignment.task_id,
        title: assignment.title,
        difficulty_minutes: assignment.difficulty_minutes,
        requires_photo: assignment.requires_photo,
        household_id: assignment.household_id
      };

    } else if (task_id) {
      // Complete task directly (not from assignment)
      task = await queryOne(`
        SELECT 
          t.task_id,
          t.title,
          t.difficulty_minutes,
          t.requires_photo,
          t.household_id
        FROM tasks t
        JOIN household_members hm ON t.household_id = hm.household_id
        WHERE t.task_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND t.is_active = 1
      `, [task_id, req.user.userId]);

      if (!task) {
        await rollbackTransaction(connection);
        return res.status(404).json({
          success: false,
          error: {
            code: 'TASK_NOT_FOUND',
            message: 'Naloga ni najdena'
          }
        });
      }
    } else {
      await rollbackTransaction(connection);
      return res.status(400).json({
        success: false,
        error: {
          code: 'TASK_OR_ASSIGNMENT_REQUIRED',
          message: 'Potreben je task_id ali assignment_id'
        }
      });
    }

    // Validate photo requirement
    if (task.requires_photo && !proof_image) {
      await rollbackTransaction(connection);
      return res.status(400).json({
        success: false,
        error: {
          code: 'PHOTO_REQUIRED',
          message: 'Za to nalogo je potrebna fotografija dokaza'
        }
      });
    }

    // Calculate points (difficulty_minutes = points)
    const pointsEarned = task.difficulty_minutes;

    // Create completion record
    const completionResult = await connection.execute(`
      INSERT INTO task_completions (
        task_id, assignment_id, completed_by_user_id, 
        completed_at, points_earned, comment, proof_image
      ) VALUES (?, ?, ?, NOW(), ?, ?, ?)
    `, [
      task.task_id, assignment_id, req.user.userId,
      pointsEarned, comment, proof_image
    ]);

    const completionId = completionResult[0].insertId;

    // Update assignment status if applicable
    if (assignment) {
      await connection.execute(`
        UPDATE task_assignments 
        SET 
          status = 'completed',
          updated_at = NOW()
        WHERE assignment_id = ?
      `, [assignment_id]);
    }

    // Commit transaction
    await commitTransaction(connection);

    // Fetch completed task details
    const completedTask = await queryOne(`
      SELECT 
        tc.completion_id,
        tc.task_id,
        tc.assignment_id,
        tc.completed_at,
        tc.points_earned,
        tc.comment,
        -- Task info
        t.title as task_title,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      WHERE tc.completion_id = ?
    `, [completionId]);

    res.status(201).json({
      success: true,
      data: {
        completion: completedTask,
        message: `Naloga "${task.title}" je bila uspešno opravljena! Zaslužili ste ${pointsEarned} točk.`
      }
    });

  } catch (error) {
    if (connection) {
      await rollbackTransaction(connection);
    }

    console.error('Complete task error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'COMPLETE_TASK_ERROR',
        message: 'Napaka pri opravljanju naloge'
      }
    });
  }
});

// =============================================================================
// POST /completions/with-photo - Complete Task with Photo Upload
// =============================================================================

router.post('/with-photo', uploadSingle('proof_photo'), async (req, res) => {
  let connection;
  
  try {
    const {
      task_id,
      assignment_id,
      comment
    } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'PHOTO_REQUIRED',
          message: 'Fotografija dokaza je obvezna'
        }
      });
    }

    // Begin transaction
    connection = await beginTransaction();

    let assignment = null;
    let task = null;

    if (assignment_id) {
      // Complete via assignment
      assignment = await queryOne(`
        SELECT 
          ta.assignment_id,
          ta.task_id,
          ta.assigned_to_user_id,
          ta.due_date,
          ta.status,
          t.title,
          t.difficulty_minutes,
          t.requires_photo,
          t.household_id
        FROM task_assignments ta
        JOIN tasks t ON ta.task_id = t.task_id
        WHERE ta.assignment_id = ? AND ta.assigned_to_user_id = ? AND ta.is_active = 1
      `, [assignment_id, req.user.userId]);

      if (!assignment) {
        await rollbackTransaction(connection);
        return res.status(404).json({
          success: false,
          error: {
            code: 'ASSIGNMENT_NOT_FOUND',
            message: 'Dodeljena naloga ni najdena'
          }
        });
      }

      if (assignment.status === 'completed') {
        await rollbackTransaction(connection);
        return res.status(400).json({
          success: false,
          error: {
            code: 'ASSIGNMENT_ALREADY_COMPLETED',
            message: 'Naloga je že opravljena'
          }
        });
      }

      task = {
        task_id: assignment.task_id,
        title: assignment.title,
        difficulty_minutes: assignment.difficulty_minutes,
        requires_photo: assignment.requires_photo,
        household_id: assignment.household_id
      };

    } else if (task_id) {
      // Complete task directly
      task = await queryOne(`
        SELECT 
          t.task_id,
          t.title,
          t.difficulty_minutes,
          t.requires_photo,
          t.household_id
        FROM tasks t
        JOIN household_members hm ON t.household_id = hm.household_id
        WHERE t.task_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND t.is_active = 1
      `, [task_id, req.user.userId]);

      if (!task) {
        await rollbackTransaction(connection);
        return res.status(404).json({
          success: false,
          error: {
            code: 'TASK_NOT_FOUND',
            message: 'Naloga ni najdena'
          }
        });
      }
    }

    // Calculate points
    const pointsEarned = task.difficulty_minutes;

    // Create completion record with uploaded photo
    const completionResult = await connection.execute(`
      INSERT INTO task_completions (
        task_id, assignment_id, completed_by_user_id, 
        completed_at, points_earned, comment, proof_image
      ) VALUES (?, ?, ?, NOW(), ?, ?, ?)
    `, [
      task.task_id, assignment_id, req.user.userId,
      pointsEarned, comment, req.file.filename
    ]);

    const completionId = completionResult[0].insertId;

    // Update assignment status if applicable
    if (assignment) {
      await connection.execute(`
        UPDATE task_assignments 
        SET 
          status = 'completed',
          updated_at = NOW()
        WHERE assignment_id = ?
      `, [assignment_id]);
    }

    // Save image metadata
    await connection.execute(`
      INSERT INTO images (
        filename, original_name, mime_type, size, 
        uploaded_by_user_id, related_entity, related_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'task_completion', ?, NOW())
    `, [
      req.file.filename, req.file.originalname, req.file.mimetype, 
      req.file.size, req.user.userId, completionId
    ]);

    // Commit transaction
    await commitTransaction(connection);

    // Fetch completed task details
    const completedTask = await queryOne(`
      SELECT 
        tc.completion_id,
        tc.task_id,
        tc.assignment_id,
        tc.completed_at,
        tc.points_earned,
        tc.comment,
        tc.proof_image,
        -- Task info
        t.title as task_title,
        -- Category info
        cat.name as category_name,
        cat.icon as category_icon
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      WHERE tc.completion_id = ?
    `, [completionId]);

    res.status(201).json({
      success: true,
      data: {
        completion: completedTask,
        proof_image_url: `/api/images/${req.file.filename}`,
        message: `Naloga "${task.title}" je bila uspešno opravljena s fotografijo! Zaslužili ste ${pointsEarned} točk.`
      }
    });

  } catch (error) {
    if (connection) {
      await rollbackTransaction(connection);
    }

    console.error('Complete task with photo error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'COMPLETE_TASK_WITH_PHOTO_ERROR',
        message: 'Napaka pri opravljanju naloge s fotografijo'
      }
    });
  }
});

// =============================================================================
// PUT /completions/:id - Update Completion (comment only)
// =============================================================================

router.put('/:id', validate(completionSchemas.update), async (req, res) => {
  try {
    const completionId = req.params.id;
    const { comment } = req.body;

    // Check if completion exists and user owns it
    const completion = await queryOne(`
      SELECT 
        tc.completion_id,
        tc.completed_by_user_id,
        tc.completed_at,
        t.title as task_title
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      WHERE tc.completion_id = ? AND tc.completed_by_user_id = ?
    `, [completionId, req.user.userId]);

    if (!completion) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'COMPLETION_NOT_FOUND',
          message: 'Opravljene naloge ni mogoče najti'
        }
      });
    }

    // Only allow editing within 24 hours
    const completedAt = new Date(completion.completed_at);
    const now = new Date();
    const hoursDiff = (now - completedAt) / (1000 * 60 * 60);

    if (hoursDiff > 24) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'EDIT_TIME_EXPIRED',
          message: 'Komentar lahko urejate le v 24 urah po opravljeni nalogi'
        }
      });
    }

    // Update comment
    await query(`
      UPDATE task_completions 
      SET comment = ?
      WHERE completion_id = ?
    `, [comment, completionId]);

    res.json({
      success: true,
      data: {
        message: `Komentar za nalogo "${completion.task_title}" je bil posodobljen`
      }
    });

  } catch (error) {
    console.error('Update completion error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'UPDATE_COMPLETION_ERROR',
        message: 'Napaka pri posodabljanju opravljene naloge'
      }
    });
  }
});

// =============================================================================
// GET /completions/stats/summary - Get Completion Statistics Summary
// =============================================================================

router.get('/stats/summary', async (req, res) => {
  try {
    const { period = '30', household_id } = req.query;

    let householdCondition = '';
    let householdParams = [];

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

      householdCondition = 'AND t.household_id = ?';
      householdParams = [parseInt(household_id)];
    }

    // Get summary stats
    const summary = await queryOne(`
      SELECT 
        COUNT(DISTINCT tc.completion_id) as total_completions,
        COUNT(DISTINCT CASE WHEN tc.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY) THEN tc.completion_id END) as recent_completions,
        COALESCE(SUM(tc.points_earned), 0) as total_points_earned,
        COALESCE(SUM(CASE WHEN tc.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY) THEN tc.points_earned ELSE 0 END), 0) as recent_points_earned,
        COUNT(DISTINCT tc.task_id) as unique_tasks_completed,
        COALESCE(AVG(tc.points_earned), 0) as avg_points_per_completion
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      WHERE tc.completed_by_user_id = ? ${householdCondition}
    `, [period, period, req.user.userId, ...householdParams]);

    res.json({
      success: true,
      data: {
        summary,
        period_days: parseInt(period)
      }
    });

  } catch (error) {
    console.error('Get completion stats summary error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_COMPLETION_STATS_ERROR',
        message: 'Napaka pri pridobivanju statistik opravljenih nalog'
      }
    });
  }
});

module.exports = router;