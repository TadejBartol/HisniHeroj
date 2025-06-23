// =============================================================================
// Database Connection and Utilities
// =============================================================================

const mysql = require('mysql2/promise');
const cron = require('node-cron');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

// =============================================================================
// DATABASE CONNECTION POOL
// =============================================================================

const pool = mysql.createPool({
  host: process.env.DATABASE_HOST || 'localhost',
  port: process.env.DATABASE_PORT || 3306,
  user: process.env.DATABASE_USER || 'hisniheroj',
  password: process.env.DATABASE_PASSWORD || 'admin123',
  database: process.env.DATABASE_NAME || 'hisniheroj',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  acquireTimeout: 60000,
  timeout: 60000,
  ssl: false
});

// =============================================================================
// DATABASE HELPER FUNCTIONS
// =============================================================================

/**
 * Test database connection
 */
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    logger.info('Database connection test successful');
    return true;
  } catch (error) {
    logger.error('Database connection test failed:', error.message);
    throw error;
  }
}

/**
 * Execute a query with parameters
 */
async function query(sql, params = []) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    logger.error('Database query error:', { sql, params, error: error.message });
    throw error;
  }
}

/**
 * Execute a query and return first result
 */
async function queryOne(sql, params = []) {
  const results = await query(sql, params);
  return results.length > 0 ? results[0] : null;
}

/**
 * Begin transaction
 */
async function beginTransaction() {
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  return connection;
}

/**
 * Commit transaction
 */
async function commitTransaction(connection) {
  await connection.commit();
  connection.release();
}

/**
 * Rollback transaction
 */
async function rollbackTransaction(connection) {
  await connection.rollback();
  connection.release();
}

// =============================================================================
// SCHEDULED TASKS
// =============================================================================

/**
 * Generate daily task assignments
 */
async function generateDailyAssignments() {
  try {
    logger.info('Generating daily task assignments...');
    
    const sql = `
      INSERT INTO task_assignments (task_id, assigned_to, assigned_by, due_date, created_at)
      SELECT 
        t.task_id,
        CASE 
          WHEN t.is_cyclic = 1 THEN (
            SELECT hm.user_id 
            FROM household_members hm 
            WHERE hm.household_id = t.household_id 
            AND hm.is_active = 1
            ORDER BY (
              SELECT COUNT(*) 
              FROM task_assignments ta2 
              WHERE ta2.task_id = t.task_id 
              AND ta2.assigned_to = hm.user_id
            ) ASC, hm.user_id ASC
            LIMIT 1
          )
          ELSE (
            SELECT ta_prev.assigned_to 
            FROM task_assignments ta_prev 
            WHERE ta_prev.task_id = t.task_id 
            ORDER BY ta_prev.created_at DESC 
            LIMIT 1
          )
        END as assigned_to,
        t.created_by,
        CURDATE(),
        NOW()
      FROM tasks t
      WHERE t.frequency = 'daily'
        AND t.is_active = 1
        AND NOT EXISTS (
          SELECT 1 FROM task_assignments ta 
          WHERE ta.task_id = t.task_id 
          AND ta.due_date = CURDATE()
        )
    `;
    
    const result = await query(sql);
    logger.info(`Generated ${result.affectedRows} daily assignments`);
    
  } catch (error) {
    logger.error('Error generating daily assignments:', error.message);
  }
}

/**
 * Generate weekly task assignments (every Monday)
 */
async function generateWeeklyAssignments() {
  try {
    logger.info('Generating weekly task assignments...');
    
    const sql = `
      INSERT INTO task_assignments (task_id, assigned_to, assigned_by, due_date, created_at)
      SELECT 
        t.task_id,
        CASE 
          WHEN t.is_cyclic = 1 THEN (
            SELECT hm.user_id 
            FROM household_members hm 
            WHERE hm.household_id = t.household_id 
            AND hm.is_active = 1
            ORDER BY (
              SELECT COUNT(*) 
              FROM task_assignments ta2 
              WHERE ta2.task_id = t.task_id 
              AND ta2.assigned_to = hm.user_id
            ) ASC, hm.user_id ASC
            LIMIT 1
          )
          ELSE (
            SELECT ta_prev.assigned_to 
            FROM task_assignments ta_prev 
            WHERE ta_prev.task_id = t.task_id 
            ORDER BY ta_prev.created_at DESC 
            LIMIT 1
          )
        END as assigned_to,
        t.created_by,
        DATE_ADD(CURDATE(), INTERVAL (7 - WEEKDAY(CURDATE())) DAY),
        NOW()
      FROM tasks t
      WHERE t.frequency = 'weekly'
        AND t.is_active = 1
        AND NOT EXISTS (
          SELECT 1 FROM task_assignments ta 
          WHERE ta.task_id = t.task_id 
          AND WEEK(ta.due_date) = WEEK(CURDATE())
          AND YEAR(ta.due_date) = YEAR(CURDATE())
        )
    `;
    
    const result = await query(sql);
    logger.info(`Generated ${result.affectedRows} weekly assignments`);
    
  } catch (error) {
    logger.error('Error generating weekly assignments:', error.message);
  }
}

/**
 * Mark overdue assignments
 */
async function markOverdueAssignments() {
  try {
    const sql = `
      UPDATE task_assignments 
      SET status = 'overdue' 
      WHERE status = 'pending' 
        AND due_date < CURDATE()
    `;
    
    const result = await query(sql);
    if (result.affectedRows > 0) {
      logger.info(`Marked ${result.affectedRows} assignments as overdue`);
    }
    
  } catch (error) {
    logger.error('Error marking overdue assignments:', error.message);
  }
}

/**
 * Start all scheduled tasks
 */
function runScheduledTasks() {
  // Daily assignments at 6:00 AM
  cron.schedule('0 6 * * *', generateDailyAssignments);
  
  // Weekly assignments every Monday at 6:00 AM
  cron.schedule('0 6 * * 1', generateWeeklyAssignments);
  
  // Check for overdue assignments every hour
  cron.schedule('0 * * * *', markOverdueAssignments);
  
  logger.info('Scheduled tasks initialized');
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Generate unique invite code for household
 */
async function generateInviteCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  let isUnique = false;
  
  while (!isUnique) {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    
    const existing = await queryOne(
      'SELECT household_id FROM households WHERE invite_code = ?',
      [code]
    );
    
    if (!existing) {
      isUnique = true;
    }
  }
  
  return code;
}

/**
 * Calculate user points from task completions
 */
async function calculateUserPoints(userId) {
  const result = await queryOne(`
    SELECT 
      COALESCE(SUM(tc.points_earned), 0) as total_earned,
      COALESCE(SUM(rc.points_spent), 0) as total_spent,
      COALESCE(SUM(tc.points_earned), 0) - COALESCE(SUM(rc.points_spent), 0) as current_points
    FROM users u
    LEFT JOIN task_completions tc ON u.user_id = tc.completed_by
    LEFT JOIN reward_claims rc ON u.user_id = rc.claimed_by AND rc.status = 'fulfilled'
    WHERE u.user_id = ?
    GROUP BY u.user_id
  `, [userId]);
  
  return result || { total_earned: 0, total_spent: 0, current_points: 0 };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  pool,
  query,
  queryOne,
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  testConnection,
  runScheduledTasks,
  generateInviteCode,
  calculateUserPoints
}; 