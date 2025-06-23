// =============================================================================
// Dashboard & Statistics Routes
// =============================================================================

const express = require('express');
const { query, queryOne } = require('../models/database');
const router = express.Router();

// =============================================================================
// GET /dashboard/personal - Personal Dashboard Data
// =============================================================================

router.get('/personal', async (req, res) => {
  try {
    const { household_id } = req.query;

    // Get user's active household if not specified
    let targetHouseholdId = household_id;
    
    if (!targetHouseholdId) {
      const userHousehold = await queryOne(`
        SELECT h.household_id 
        FROM household_members hm
        JOIN households h ON hm.household_id = h.household_id
        WHERE hm.user_id = ? AND hm.is_active = 1 AND h.is_active = 1
        ORDER BY hm.joined_at DESC
        LIMIT 1
      `, [req.user.userId]);
      
      targetHouseholdId = userHousehold?.household_id;
    }

    if (!targetHouseholdId) {
      return res.json({
        success: true,
        data: {
          summary: { message: 'Niste član nobenega doma' },
          today_assignments: [],
          recent_completions: [],
          points_summary: { current_balance: 0 }
        }
      });
    }

    // Verify access to household
    const hasAccess = await queryOne(`
      SELECT membership_id FROM household_members 
      WHERE household_id = ? AND user_id = ? AND is_active = 1
    `, [targetHouseholdId, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega doma'
        }
      });
    }

    // 1. Personal Summary Stats
    const personalSummary = await queryOne(`
      SELECT 
        -- Today's assignments
        COUNT(DISTINCT CASE WHEN ta.status IN ('pending', 'overdue') AND ta.is_active = 1 
                           AND DATE(ta.due_date) <= CURDATE() THEN ta.assignment_id END) as today_tasks,
        COUNT(DISTINCT CASE WHEN ta.status = 'overdue' AND ta.is_active = 1 THEN ta.assignment_id END) as overdue_tasks,
        
        -- This week's completions
        COUNT(DISTINCT CASE WHEN tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) 
                           THEN tc.completion_id END) as week_completions,
        
        -- This month's stats
        COUNT(DISTINCT CASE WHEN tc.completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') 
                           THEN tc.completion_id END) as month_completions,
        COALESCE(SUM(CASE WHEN tc.completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') 
                         THEN tc.points_earned ELSE 0 END), 0) as month_points
      FROM users u
      LEFT JOIN task_assignments ta ON u.user_id = ta.assigned_to
      LEFT JOIN tasks task_for_assignment ON ta.task_id = task_for_assignment.task_id AND task_for_assignment.household_id = ?
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by
      LEFT JOIN tasks task_for_completion ON tc.task_id = task_for_completion.task_id AND task_for_completion.household_id = ?
      WHERE u.user_id = ?
    `, [targetHouseholdId, targetHouseholdId, req.user.userId]);

    // 2. Today's Assignments
    const todayAssignments = await query(`
      SELECT 
        ta.assignment_id,
        ta.task_id,
        ta.due_date,
        ta.status,
        t.title,
        t.difficulty_minutes,
        t.requires_proof,
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        CASE WHEN ta.due_date < NOW() AND ta.status = 'pending' THEN 1 ELSE 0 END as is_overdue
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      WHERE ta.assigned_to = ? 
        AND t.household_id = ?
        AND ta.is_active = 1 
        AND ta.status IN ('pending', 'overdue')
        AND DATE(ta.due_date) <= CURDATE()
      ORDER BY 
        CASE WHEN ta.status = 'overdue' THEN 1 ELSE 2 END,
        ta.due_date ASC
      LIMIT 10
    `, [req.user.userId, targetHouseholdId]);

    // 3. Recent Completions
    const recentCompletions = await query(`
      SELECT 
        tc.completion_id,
        tc.completed_at,
        tc.points_earned,
        tc.comment,
        t.title,
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        CASE WHEN tc.assignment_id IS NOT NULL THEN 1 ELSE 0 END as was_assignment
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      WHERE tc.completed_by = ? 
        AND t.household_id = ?
      ORDER BY tc.completed_at DESC
      LIMIT 10
    `, [req.user.userId, targetHouseholdId]);

    // 4. Points Summary
    const pointsSummary = await queryOne(`
      SELECT 
        COALESCE(SUM(tc.points_earned), 0) as total_earned,
        COALESCE(SUM(rc.points_spent), 0) as total_spent,
        COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc.points_spent), 0) as current_balance,
        -- This month
        COALESCE(SUM(CASE WHEN tc.completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') 
                         THEN tc.points_earned ELSE 0 END), 0) as month_earned,
        COALESCE(SUM(CASE WHEN rc.claimed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND rc.status = 'fulfilled'
                         THEN rc.points_spent ELSE 0 END), 0) as month_spent
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      LEFT JOIN reward_claims rc ON rc.claimed_by = tc.completed_by AND rc.status = 'fulfilled'
      WHERE tc.completed_by = ? AND t.household_id = ?
    `, [req.user.userId, targetHouseholdId]);

    // 5. Upcoming Assignments (next 7 days)
    const upcomingAssignments = await query(`
      SELECT 
        ta.assignment_id,
        ta.due_date,
        t.title,
        cat.name as category_name,
        cat.icon as category_icon,
        DATEDIFF(ta.due_date, CURDATE()) as days_until_due
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      WHERE ta.assigned_to = ? 
        AND t.household_id = ?
        AND ta.is_active = 1 
        AND ta.status = 'pending'
        AND ta.due_date > CURDATE()
        AND ta.due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
      ORDER BY ta.due_date ASC
      LIMIT 5
    `, [req.user.userId, targetHouseholdId]);

    res.json({
      success: true,
      data: {
        household_id: targetHouseholdId,
        summary: personalSummary,
        today_assignments: todayAssignments,
        upcoming_assignments: upcomingAssignments,
        recent_completions: recentCompletions,
        points_summary: pointsSummary
      }
    });

  } catch (error) {
    console.error('Get personal dashboard error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_PERSONAL_DASHBOARD_ERROR',
        message: 'Napaka pri pridobivanju osebnega nadzorne plošče'
      }
    });
  }
});

// =============================================================================
// GET /dashboard/household/:id - Household Dashboard Data
// =============================================================================

router.get('/household/:id', async (req, res) => {
  try {
    const householdId = req.params.id;

    // Verify access to household
    const hasAccess = await queryOne(`
      SELECT 
        hm.membership_id,
        hm.role,
        h.name as household_name
      FROM household_members hm
      JOIN households h ON hm.household_id = h.household_id
      WHERE hm.household_id = ? AND hm.user_id = ? AND hm.is_active = 1 AND h.is_active = 1
    `, [householdId, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega doma'
        }
      });
    }

    // 1. Household Summary
    const householdSummary = await queryOne(`
      SELECT 
        -- Member stats
        COUNT(DISTINCT hm.user_id) as total_members,
        COUNT(DISTINCT CASE WHEN u.last_login >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN hm.user_id END) as active_members,
        
        -- Task stats
        COUNT(DISTINCT t.task_id) as total_tasks,
        COUNT(DISTINCT CASE WHEN ta.status IN ('pending', 'overdue') AND ta.is_active = 1 THEN ta.assignment_id END) as pending_assignments,
        COUNT(DISTINCT CASE WHEN ta.status = 'overdue' AND ta.is_active = 1 THEN ta.assignment_id END) as overdue_assignments,
        
        -- This month's activity
        COUNT(DISTINCT CASE WHEN tc.completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN tc.completion_id END) as month_completions,
        COALESCE(SUM(CASE WHEN tc.completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN tc.points_earned ELSE 0 END), 0) as month_points,
        
        -- Rewards
        COUNT(DISTINCT r.reward_id) as total_rewards,
        COUNT(DISTINCT CASE WHEN rc.status = 'pending' THEN rc.claim_id END) as pending_reward_claims
      FROM households h
      LEFT JOIN household_members hm ON h.household_id = hm.household_id AND hm.is_active = 1
      LEFT JOIN users u ON hm.user_id = u.user_id AND u.is_active = 1
      LEFT JOIN tasks t ON h.household_id = t.household_id AND t.is_active = 1
      LEFT JOIN task_assignments ta ON t.task_id = ta.task_id AND ta.is_active = 1
      LEFT JOIN task_completions tc ON t.task_id = tc.task_id
      LEFT JOIN rewards r ON h.household_id = r.household_id AND r.is_active = 1
      LEFT JOIN reward_claims rc ON r.reward_id = rc.reward_id
      WHERE h.household_id = ?
    `, [householdId]);

    // 2. Member Activity Summary
    const memberActivity = await query(`
      SELECT 
        u.user_id,
        u.first_name,
        u.last_name,
        u.profile_image,
        u.last_login,
        hm.role,
        -- This month's stats
        COUNT(DISTINCT CASE WHEN tc.completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN tc.completion_id END) as month_completions,
        COALESCE(SUM(CASE WHEN tc.completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN tc.points_earned ELSE 0 END), 0) as month_points,
        -- Current assignments
        COUNT(DISTINCT CASE WHEN ta.status IN ('pending', 'overdue') AND ta.is_active = 1 THEN ta.assignment_id END) as current_assignments,
        COUNT(DISTINCT CASE WHEN ta.status = 'overdue' AND ta.is_active = 1 THEN ta.assignment_id END) as overdue_assignments,
        -- Total points balance
        COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc.points_spent), 0) as points_balance
      FROM household_members hm
      JOIN users u ON hm.user_id = u.user_id
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by AND tc.task_id IN (
        SELECT task_id FROM tasks WHERE household_id = ?
      )
      LEFT JOIN task_assignments ta ON u.user_id = ta.assigned_to AND ta.task_id IN (
        SELECT task_id FROM tasks WHERE household_id = ?
      )
      LEFT JOIN reward_claims rc ON u.user_id = rc.claimed_by AND rc.status = 'fulfilled' AND rc.reward_id IN (
        SELECT reward_id FROM rewards WHERE household_id = ?
      )
      WHERE hm.household_id = ? AND hm.is_active = 1 AND u.is_active = 1
      GROUP BY u.user_id, u.first_name, u.last_name, u.profile_image, u.last_login, hm.role
      ORDER BY month_points DESC, month_completions DESC
    `, [householdId, householdId, householdId, householdId]);

    // 3. Category Performance
    const categoryPerformance = await query(`
      SELECT 
        cat.category_id,
        cat.name,
        cat.icon,
        cat.color,
        COUNT(DISTINCT t.task_id) as task_count,
        COUNT(DISTINCT tc.completion_id) as completion_count,
        COALESCE(SUM(tc.points_earned), 0) as total_points,
        COALESCE(AVG(tc.points_earned), 0) as avg_points_per_completion,
        COUNT(DISTINCT tc.completed_by) as active_users
      FROM task_categories cat
      LEFT JOIN tasks t ON cat.category_id = t.category_id AND t.household_id = ? AND t.is_active = 1
      LEFT JOIN task_completions tc ON t.task_id = tc.task_id
      WHERE cat.is_active = 1
      GROUP BY cat.category_id, cat.name, cat.icon, cat.color
      HAVING task_count > 0
      ORDER BY completion_count DESC, total_points DESC
    `, [householdId]);

    // 4. Recent Activity Feed
    const recentActivity = await query(`
      SELECT 
        'completion' as activity_type,
        tc.completion_id as activity_id,
        tc.completed_at as activity_date,
        tc.points_earned,
        tc.comment,
        t.title as task_title,
        cat.name as category_name,
        cat.icon as category_icon,
        u.first_name,
        u.last_name,
        u.profile_image,
        NULL as reward_title
      FROM task_completions tc
      JOIN users u ON tc.completed_by = u.user_id
      JOIN tasks t ON tc.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      WHERE t.household_id = ?
      
      UNION ALL
      
      SELECT 
        'reward_claim' as activity_type,
        rc.claim_id as activity_id,
        rc.claimed_at as activity_date,
        -rc.points_spent as points_earned,
        rc.admin_notes as comment,
        NULL as task_title,
        NULL as category_name,
        NULL as category_icon,
        u.first_name,
        u.last_name,
        u.profile_image,
        r.title as reward_title
      FROM reward_claims rc
      JOIN users u ON rc.claimed_by = u.user_id
      JOIN rewards r ON rc.reward_id = r.reward_id
      WHERE r.household_id = ?
      
      ORDER BY activity_date DESC
      LIMIT 20
    `, [householdId, householdId]);

    res.json({
      success: true,
      data: {
        household: {
          household_id: householdId,
          name: hasAccess.household_name,
          user_role: hasAccess.role
        },
        summary: householdSummary,
        members: memberActivity,
        categories: categoryPerformance,
        recent_activity: recentActivity
      }
    });

  } catch (error) {
    console.error('Get household dashboard error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_HOUSEHOLD_DASHBOARD_ERROR',
        message: 'Napaka pri pridobivanju nadzorne plošče doma'
      }
    });
  }
});

// =============================================================================
// GET /dashboard/leaderboard/:id - Household Leaderboard
// =============================================================================

router.get('/leaderboard/:id', async (req, res) => {
  try {
    const householdId = req.params.id;
    const { period = 'month', metric = 'points' } = req.query;

    // Verify access
    const hasAccess = await queryOne(`
      SELECT membership_id FROM household_members 
      WHERE household_id = ? AND user_id = ? AND is_active = 1
    `, [householdId, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega doma'
        }
      });
    }

    // Build date filter based on period
    let dateFilter = '';
    switch (period) {
      case 'week':
        dateFilter = 'AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)';
        break;
      case 'month':
        dateFilter = "AND tc.completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')";
        break;
      case 'year':
        dateFilter = "AND tc.completed_at >= DATE_FORMAT(CURDATE(), '%Y-01-01')";
        break;
      case 'all':
      default:
        dateFilter = '';
        break;
    }

    // Build metric selection
    let metricSelect = '';
    let orderBy = '';
    switch (metric) {
      case 'completions':
        metricSelect = 'COUNT(DISTINCT tc.completion_id) as metric_value';
        orderBy = 'metric_value DESC, total_points DESC';
        break;
      case 'points':
      default:
        metricSelect = 'COALESCE(SUM(tc.points_earned), 0) as metric_value';
        orderBy = 'metric_value DESC, total_completions DESC';
        break;
    }

    const leaderboard = await query(`
      SELECT 
        u.user_id,
        u.first_name,
        u.last_name,
        u.profile_image,
        hm.role,
        ${metricSelect},
        COUNT(DISTINCT tc.completion_id) as total_completions,
        COALESCE(SUM(tc.points_earned), 0) as total_points,
        -- Ranking
        ROW_NUMBER() OVER (ORDER BY ${orderBy}) as rank_position,
        -- Category breakdown
        COUNT(DISTINCT CASE WHEN cat.name = 'Kuhinja' THEN tc.completion_id END) as kitchen_completions,
        COUNT(DISTINCT CASE WHEN cat.name = 'Čiščenje' THEN tc.completion_id END) as cleaning_completions,
        COUNT(DISTINCT CASE WHEN cat.name = 'Vrt' THEN tc.completion_id END) as garden_completions,
        COUNT(DISTINCT CASE WHEN cat.name = 'Pranje' THEN tc.completion_id END) as laundry_completions,
        COUNT(DISTINCT CASE WHEN cat.name = 'Ostalo' THEN tc.completion_id END) as other_completions,
        -- Recent activity
        MAX(tc.completed_at) as last_completion,
        COUNT(DISTINCT CASE WHEN tc.completed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN tc.completion_id END) as week_completions
      FROM household_members hm
      JOIN users u ON hm.user_id = u.user_id
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by ${dateFilter}
      LEFT JOIN tasks t ON tc.task_id = t.task_id AND t.household_id = ?
      LEFT JOIN task_categories cat ON t.category_id = cat.category_id
      WHERE hm.household_id = ? AND hm.is_active = 1 AND u.is_active = 1
      GROUP BY u.user_id, u.first_name, u.last_name, u.profile_image, hm.role
      ORDER BY ${orderBy}
    `, [householdId, householdId]);

    // Calculate percentage of top performer for relative scores
    const topScore = leaderboard.length > 0 ? leaderboard[0].metric_value : 0;

    const leaderboardWithPercentages = leaderboard.map(member => ({
      ...member,
      metric_percentage: topScore > 0 ? Math.round((member.metric_value / topScore) * 100) : 0,
      is_current_user: member.user_id === req.user.userId
    }));

    res.json({
      success: true,
      data: {
        period,
        metric,
        leaderboard: leaderboardWithPercentages,
        stats: {
          total_participants: leaderboard.length,
          top_score: topScore,
          total_completions: leaderboard.reduce((sum, m) => sum + m.total_completions, 0),
          total_points: leaderboard.reduce((sum, m) => sum + m.total_points, 0)
        }
      }
    });

  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_LEADERBOARD_ERROR',
        message: 'Napaka pri pridobivanju lestvice'
      }
    });
  }
});

// =============================================================================
// GET /dashboard/analytics/:household_id - Advanced Analytics
// =============================================================================

router.get('/analytics/:household_id', async (req, res) => {
  try {
    const householdId = req.params.household_id;
    const { period = 'month', start_date, end_date } = req.query;

    // Verify access to household
    const hasAccess = await queryOne(`
      SELECT membership_id FROM household_members 
      WHERE household_id = ? AND user_id = ? AND is_active = 1
    `, [householdId, req.user.userId]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'HOUSEHOLD_ACCESS_DENIED',
          message: 'Nimate dostopa do tega doma'
        }
      });
    }

    // Build date filter based on period or custom dates
    let dateFilter = '';
    let dateParams = [];

    if (start_date && end_date) {
      dateFilter = 'AND tc.completed_at BETWEEN ? AND ?';
      dateParams = [start_date, end_date];
    } else {
      switch (period) {
        case 'week':
          dateFilter = 'AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL 1 WEEK)';
          break;
        case 'month':
          dateFilter = 'AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)';
          break;
        case 'quarter':
          dateFilter = 'AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)';
          break;
        case 'year':
          dateFilter = 'AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)';
          break;
        default:
          dateFilter = 'AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)';
      }
    }

    // 1. Completion Trends (daily aggregation)
    const completionTrends = await query(`
      SELECT 
        DATE(tc.completed_at) as completion_date,
        COUNT(DISTINCT tc.completion_id) as completion_count,
        COALESCE(SUM(tc.points_earned), 0) as total_points,
        COUNT(DISTINCT tc.completed_by) as active_users
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      WHERE t.household_id = ? ${dateFilter}
      GROUP BY DATE(tc.completed_at)
      ORDER BY completion_date ASC
    `, [householdId, ...dateParams]);

    // 2. User Performance Comparison
    const userPerformance = await query(`
      SELECT 
        u.user_id,
        u.first_name,
        u.last_name,
        u.profile_image,
        COUNT(DISTINCT tc.completion_id) as completion_count,
        COALESCE(SUM(tc.points_earned), 0) as total_points,
        COALESCE(AVG(tc.points_earned), 0) as avg_points_per_task,
        COUNT(DISTINCT DATE(tc.completed_at)) as active_days,
        -- Ranking
        RANK() OVER (ORDER BY SUM(tc.points_earned) DESC) as points_rank,
        RANK() OVER (ORDER BY COUNT(tc.completion_id) DESC) as completion_rank
      FROM household_members hm
      JOIN users u ON hm.user_id = u.user_id
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by ${dateFilter}
      LEFT JOIN tasks t ON tc.task_id = t.task_id AND t.household_id = ?
      WHERE hm.household_id = ? AND hm.is_active = 1 AND u.is_active = 1
      GROUP BY u.user_id, u.first_name, u.last_name, u.profile_image
      ORDER BY total_points DESC
    `, [...dateParams, householdId, householdId]);

    // 3. Category Analysis
    const categoryAnalysis = await query(`
      SELECT 
        cat.category_id,
        cat.name,
        cat.icon,
        cat.color,
        COUNT(DISTINCT tc.completion_id) as completion_count,
        COALESCE(SUM(tc.points_earned), 0) as total_points,
        COALESCE(AVG(tc.points_earned), 0) as avg_points,
        COUNT(DISTINCT tc.completed_by) as unique_completers,
        COUNT(DISTINCT t.task_id) as task_count
      FROM task_categories cat
      LEFT JOIN tasks t ON cat.category_id = t.category_id AND t.household_id = ? AND t.is_active = 1
      LEFT JOIN task_completions tc ON t.task_id = tc.task_id ${dateFilter}
      WHERE cat.is_active = 1
      GROUP BY cat.category_id, cat.name, cat.icon, cat.color
      HAVING completion_count > 0
      ORDER BY completion_count DESC
    `, [householdId, ...dateParams]);

    // 4. Task Difficulty Analysis
    const difficultyAnalysis = await query(`
      SELECT 
        CASE 
          WHEN t.difficulty_minutes <= 15 THEN 'Lahko'
          WHEN t.difficulty_minutes <= 30 THEN 'Srednje'
          WHEN t.difficulty_minutes <= 60 THEN 'Težko'
          ELSE 'Zelo težko'
        END as difficulty_level,
        t.difficulty_minutes,
        COUNT(DISTINCT tc.completion_id) as completion_count,
        COALESCE(SUM(tc.points_earned), 0) as total_points,
        COALESCE(AVG(tc.points_earned), 0) as avg_points,
        COUNT(DISTINCT t.task_id) as task_count
      FROM tasks t
      LEFT JOIN task_completions tc ON t.task_id = tc.task_id ${dateFilter}
      WHERE t.household_id = ? AND t.is_active = 1
      GROUP BY 
        CASE 
          WHEN t.difficulty_minutes <= 15 THEN 'Lahko'
          WHEN t.difficulty_minutes <= 30 THEN 'Srednje'
          WHEN t.difficulty_minutes <= 60 THEN 'Težko'
          ELSE 'Zelo težko'
        END,
        t.difficulty_minutes
      ORDER BY t.difficulty_minutes ASC
    `, [...dateParams, householdId]);

    res.json({
      success: true,
      data: {
        period: period,
        date_range: {
          start: start_date || `${period} ago`,
          end: end_date || 'now'
        },
        trends: completionTrends,
        user_performance: userPerformance,
        category_analysis: categoryAnalysis,
        difficulty_analysis: difficultyAnalysis
      }
    });

  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GET_ANALYTICS_ERROR',
        message: 'Napaka pri pridobivanju analitike'
      }
    });
  }
});

module.exports = router;