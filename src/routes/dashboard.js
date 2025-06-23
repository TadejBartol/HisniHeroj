// =============================================================================
// Dashboard & Statistics Routes
// =============================================================================

const express = require('express');
const { query, queryOne } = require('../models/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Apply authentication to all dashboard routes
router.use(authenticate);

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
      LEFT JOIN task_assignments ta ON u.user_id = ta.assigned_to_user_id
      LEFT JOIN tasks task_for_assignment ON ta.task_id = task_for_assignment.task_id AND task_for_assignment.household_id = ?
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by_user_id
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
        t.requires_photo,
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        CASE WHEN ta.due_date < NOW() AND ta.status = 'pending' THEN 1 ELSE 0 END as is_overdue
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      WHERE ta.assigned_to_user_id = ? 
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
      WHERE tc.completed_by_user_id = ? 
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
        COALESCE(SUM(CASE WHEN rc.claimed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND rc.is_fulfilled = 1
                         THEN rc.points_spent ELSE 0 END), 0) as month_spent
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      LEFT JOIN reward_claims rc ON rc.claimed_by_user_id = tc.completed_by_user_id AND rc.is_fulfilled = 1
      WHERE tc.completed_by_user_id = ? AND t.household_id = ?
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
      WHERE ta.assigned_to_user_id = ? 
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
        COUNT(DISTINCT CASE WHEN rc.is_fulfilled = 0 THEN rc.claim_id END) as pending_reward_claims
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
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by_user_id AND tc.task_id IN (
        SELECT task_id FROM tasks WHERE household_id = ?
      )
      LEFT JOIN task_assignments ta ON u.user_id = ta.assigned_to_user_id AND ta.task_id IN (
        SELECT task_id FROM tasks WHERE household_id = ?
      )
      LEFT JOIN reward_claims rc ON u.user_id = rc.claimed_by_user_id AND rc.is_fulfilled = 1 AND rc.reward_id IN (
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
        COUNT(DISTINCT t.task_id) as total_tasks,
        COUNT(DISTINCT tc.completion_id) as total_completions,
        COALESCE(SUM(tc.points_earned), 0) as total_points,
        COUNT(DISTINCT CASE WHEN tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN tc.completion_id END) as recent_completions,
        COALESCE(AVG(tc.points_earned), 0) as avg_points_per_completion
      FROM task_categories cat
      LEFT JOIN tasks t ON cat.category_id = t.category_id AND t.household_id = ? AND t.is_active = 1
      LEFT JOIN task_completions tc ON t.task_id = tc.task_id
      WHERE cat.is_active = 1
      GROUP BY cat.category_id, cat.name, cat.icon, cat.color
      HAVING total_tasks > 0 OR total_completions > 0
      ORDER BY recent_completions DESC, total_points DESC
    `, [householdId]);

    // 4. Recent Activity Feed
    const recentActivity = await query(`
      SELECT 
        'completion' as activity_type,
        tc.completed_at as activity_time,
        tc.completion_id as activity_id,
        u.first_name,
        u.last_name,
        u.profile_image,
        t.title as task_title,
        cat.name as category_name,
        cat.icon as category_icon,
        tc.points_earned,
        tc.comment
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      JOIN task_categories cat ON t.category_id = cat.category_id
      JOIN users u ON tc.completed_by_user_id = u.user_id
      WHERE t.household_id = ?
      
      UNION ALL
      
      SELECT 
        'reward_claim' as activity_type,
        rc.claimed_at as activity_time,
        rc.claim_id as activity_id,
        u.first_name,
        u.last_name,
        u.profile_image,
        r.title as task_title,
        'reward' as category_name,
        'gift' as category_icon,
        -rc.points_spent as points_earned,
        NULL as comment
      FROM reward_claims rc
      JOIN rewards r ON rc.reward_id = r.reward_id
      JOIN users u ON rc.claimed_by_user_id = u.user_id
      WHERE r.household_id = ?
      
      ORDER BY activity_time DESC
      LIMIT 20
    `, [householdId, householdId]);

    // 5. Weekly Completion Trend (last 4 weeks)
    const weeklyTrend = await query(`
      SELECT 
        YEAR(tc.completed_at) as year,
        WEEK(tc.completed_at) as week,
        CONCAT(YEAR(tc.completed_at), '-W', LPAD(WEEK(tc.completed_at), 2, '0')) as week_label,
        COUNT(tc.completion_id) as completions,
        SUM(tc.points_earned) as points_earned,
        COUNT(DISTINCT tc.completed_by_user_id) as active_users
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      WHERE t.household_id = ? 
        AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL 4 WEEK)
      GROUP BY YEAR(tc.completed_at), WEEK(tc.completed_at)
      ORDER BY year, week
    `, [householdId]);

    res.json({
      success: true,
      data: {
        household: {
          id: householdId,
          name: hasAccess.household_name,
          user_role: hasAccess.role
        },
        summary: householdSummary,
        member_activity: memberActivity,
        category_performance: categoryPerformance,
        recent_activity: recentActivity,
        weekly_trend: weeklyTrend
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
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by_user_id ${dateFilter}
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
// GET /dashboard/analytics/:id - Household Analytics
// =============================================================================

router.get('/analytics/:id', async (req, res) => {
  try {
    const householdId = req.params.id;
    const { period = '30' } = req.query; // days

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

    // 1. Daily completion timeline
    const dailyTimeline = await query(`
      SELECT 
        DATE(tc.completed_at) as completion_date,
        COUNT(tc.completion_id) as completions,
        SUM(tc.points_earned) as points_earned,
        COUNT(DISTINCT tc.completed_by_user_id) as active_users
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      WHERE t.household_id = ? 
        AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(tc.completed_at)
      ORDER BY completion_date
    `, [householdId, period]);

    // 2. Category distribution
    const categoryDistribution = await query(`
      SELECT 
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        COUNT(tc.completion_id) as completions,
        SUM(tc.points_earned) as points_earned,
        ROUND(COUNT(tc.completion_id) * 100.0 / (
          SELECT COUNT(*) FROM task_completions tc2 
          JOIN tasks t2 ON tc2.task_id = t2.task_id 
          WHERE t2.household_id = ? AND tc2.completed_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        ), 1) as completion_percentage
      FROM task_categories cat
      JOIN tasks t ON cat.category_id = t.category_id
      JOIN task_completions tc ON t.task_id = tc.task_id
      WHERE t.household_id = ? 
        AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY cat.category_id, cat.name, cat.icon, cat.color
      ORDER BY completions DESC
    `, [householdId, period, householdId, period]);

    // 3. User performance comparison
    const userPerformance = await query(`
      SELECT 
        u.user_id,
        u.first_name,
        u.last_name,
        COUNT(tc.completion_id) as completions,
        SUM(tc.points_earned) as points_earned,
        AVG(t.difficulty_minutes) as avg_task_difficulty,
        COUNT(DISTINCT DATE(tc.completed_at)) as active_days,
        COUNT(DISTINCT t.category_id) as categories_completed
      FROM users u
      JOIN household_members hm ON u.user_id = hm.user_id
      LEFT JOIN task_completions tc ON u.user_id = tc.completed_by_user_id 
        AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      LEFT JOIN tasks t ON tc.task_id = t.task_id AND t.household_id = ?
      WHERE hm.household_id = ? AND hm.is_active = 1 AND u.is_active = 1
      GROUP BY u.user_id, u.first_name, u.last_name
      ORDER BY points_earned DESC
    `, [period, householdId, householdId]);

    // 4. Task difficulty analysis
    const difficultyAnalysis = await query(`
      SELECT 
        CASE 
          WHEN t.difficulty_minutes <= 15 THEN 'Enostavno (≤15 min)'
          WHEN t.difficulty_minutes <= 30 THEN 'Srednje (16-30 min)'
          WHEN t.difficulty_minutes <= 60 THEN 'Zahtevno (31-60 min)'
          ELSE 'Zelo zahtevno (>60 min)'
        END as difficulty_level,
        COUNT(tc.completion_id) as completions,
        SUM(tc.points_earned) as points_earned,
        AVG(t.difficulty_minutes) as avg_minutes,
        COUNT(DISTINCT tc.completed_by_user_id) as unique_completers
      FROM task_completions tc
      JOIN tasks t ON tc.task_id = t.task_id
      WHERE t.household_id = ? 
        AND tc.completed_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY difficulty_level
      ORDER BY avg_minutes
    `, [householdId, period]);

    // 5. Assignment vs completion rates
    const completionRates = await query(`
      SELECT 
        DATE(ta.created_at) as assignment_date,
        COUNT(ta.assignment_id) as assignments_created,
        COUNT(CASE WHEN ta.status = 'completed' THEN ta.assignment_id END) as assignments_completed,
        ROUND(COUNT(CASE WHEN ta.status = 'completed' THEN ta.assignment_id END) * 100.0 / COUNT(ta.assignment_id), 1) as completion_rate
      FROM task_assignments ta
      JOIN tasks t ON ta.task_id = t.task_id
      WHERE t.household_id = ? 
        AND ta.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(ta.created_at)
      HAVING assignments_created > 0
      ORDER BY assignment_date
    `, [householdId, period]);

    res.json({
      success: true,
      data: {
        period_days: parseInt(period),
        daily_timeline: dailyTimeline,
        category_distribution: categoryDistribution,
        user_performance: userPerformance,
        difficulty_analysis: difficultyAnalysis,
        completion_rates: completionRates
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