const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
require('dotenv').config();
const pool = require('./db');

process.on('unhandledRejection', (reason) => {
  console.error('>>> UNHANDLED REJECTION CAUGHT:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('>>> UNCAUGHT EXCEPTION CAUGHT:', err);
});

const app = express();
const PORT = process.env.PORT || 5000;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s+/g, '_');
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Timesheet spreadsheet uploads are parsed in memory — we never need to keep
// the raw clock-machine file itself, just the rows extracted from it.
const memUpload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 1. Login Endpoint
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const loginQuery = 'SELECT id, username, role, employee_id FROM users WHERE username = $1 AND password = $2';
    const userQuery = await pool.query(loginQuery, [username, password]);

    if (userQuery.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const user = userQuery.rows[0];
    res.json({ message: 'Login successful', user });
  } catch (err) {
    console.error("EXACT LOGIN ERROR:", err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// 2. Get Tasks for a Specific User
app.get('/api/tasks/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const tasksQuery = await pool.query(
      'SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.json(tasksQuery.rows);
  } catch (err) {
    console.error("EXACT TASK ERROR:", err.message);
    res.status(500).json({ error: 'Error fetching tasks' });
  }
});

// 3. Get All Employees
app.get('/api/employees', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employees ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT EMPLOYEES FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching employees' });
  }
});

// 4. Get One Employee by ID (includes linked login account)
app.get('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT employees.*, 
              users.username AS login_username, 
              users.password AS login_password, 
              users.role AS login_role
       FROM employees
       LEFT JOIN users ON users.employee_id = employees.id
       WHERE employees.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT EMPLOYEE FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching employee' });
  }
});

// 5. Create a New Employee
app.post('/api/employees', async (req, res) => {
  const {
    first_name, last_name, email, date_of_birth, id_number, gender,
    nationality, phone, mobile, address, department, emergency_contact,
    emergency_phone, job_title, employment_type, start_date,
    contract_end_date, salary_grade, work_schedule, employement_status
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO employees
        (first_name, last_name, email, date_of_birth, id_number, gender,
         nationality, phone, mobile, address, department, emergency_contact,
         emergency_phone, job_title, employment_type, start_date,
         contract_end_date, salary_grade, work_schedule, employement_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        first_name, last_name, email, date_of_birth || null, id_number, gender,
        nationality, phone, mobile, address, department, emergency_contact,
        emergency_phone, job_title, employment_type, start_date || null,
        contract_end_date || null, salary_grade, work_schedule,
        employement_status || 'Active'
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT EMPLOYEE CREATE ERROR:", err);
    res.status(500).json({ error: 'Error creating employee' });
  }
});

// 6. Update an Employee
app.patch('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  const {
    first_name, last_name, email, date_of_birth, id_number, gender,
    nationality, phone, mobile, address, department, emergency_contact,
    emergency_phone, job_title, employment_type, start_date,
    contract_end_date, salary_grade, work_schedule
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE employees SET
        first_name = $1, last_name = $2, email = $3, date_of_birth = $4,
        id_number = $5, gender = $6, nationality = $7, phone = $8,
        mobile = $9, address = $10, department = $11, emergency_contact = $12,
        emergency_phone = $13, job_title = $14, employment_type = $15,
        start_date = $16, contract_end_date = $17, salary_grade = $18,
        work_schedule = $19
       WHERE id = $20
       RETURNING *`,
      [
        first_name, last_name, email, date_of_birth || null, id_number, gender,
        nationality, phone, mobile, address, department, emergency_contact,
        emergency_phone, job_title, employment_type, start_date || null,
        contract_end_date || null, salary_grade, work_schedule, id
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT EMPLOYEE UPDATE ERROR:", err);
    res.status(500).json({ error: 'Error updating employee' });
  }
});

// 7. Deactivate an Employee
app.patch('/api/employees/:id/deactivate', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE employees SET employement_status = 'Inactive' WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT EMPLOYEE DEACTIVATE ERROR:", err);
    res.status(500).json({ error: 'Error deactivating employee' });
  }
});

// 8. Delete an Employee Permanently
app.delete('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  const force = req.query.force === 'true';

  if (force) {
    // Deliberately wipe every record tied to this employee, then the employee itself.
    // Only reached when the frontend has already shown a strong, explicit warning.
    // We check which tables/columns actually exist first, since the deployed schema
    // can differ slightly between environments — this keeps it safe either way.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const colCheck = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = ANY($1)`,
        [['employee_id', 'created_by', 'uploaded_by']]
      );
      const hasColumn = (table, column) => colCheck.rows.some(r => r.table_name === table && r.column_name === column);

      if (hasColumn('overtime_entries', 'employee_id')) {
        await client.query('DELETE FROM overtime_takings WHERE overtime_entry_id IN (SELECT id FROM overtime_entries WHERE employee_id = $1)', [id]);
        await client.query('DELETE FROM overtime_entries WHERE employee_id = $1', [id]);
      }
      if (hasColumn('leave_requests', 'employee_id')) {
        await client.query('DELETE FROM leave_requests WHERE employee_id = $1', [id]);
      }
      if (hasColumn('leave_table_customizations', 'employee_id')) {
        await client.query('DELETE FROM leave_table_customizations WHERE employee_id = $1', [id]);
      }
      if (hasColumn('training_completions', 'employee_id')) {
        await client.query('DELETE FROM training_completions WHERE employee_id = $1', [id]);
      }
      if (hasColumn('training_progress', 'employee_id')) {
        await client.query('DELETE FROM training_progress WHERE employee_id = $1', [id]);
      }
      if (hasColumn('timesheet_entries', 'employee_id')) {
        await client.query('DELETE FROM timesheet_entries WHERE employee_id = $1', [id]);
      }
      if (hasColumn('trainings', 'created_by')) {
        await client.query('UPDATE trainings SET created_by = NULL WHERE created_by = $1', [id]);
      }
      if (hasColumn('rss_training_learners', 'created_by')) {
        await client.query('UPDATE rss_training_learners SET created_by = NULL WHERE created_by = $1', [id]);
      }
      if (hasColumn('rss_training_manuals', 'uploaded_by')) {
        await client.query('UPDATE rss_training_manuals SET uploaded_by = NULL WHERE uploaded_by = $1', [id]);
      }
      if (hasColumn('users', 'employee_id')) {
        await client.query('DELETE FROM users WHERE employee_id = $1', [id]);
      }

      const result = await client.query('DELETE FROM employees WHERE id = $1 RETURNING *', [id]);
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Employee not found' });
      }
      await client.query('COMMIT');
      return res.json({ message: 'Employee and all related records deleted', employee: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error("EXACT EMPLOYEE FORCE DELETE ERROR:", err);
      return res.status(500).json({ error: 'Error force-deleting employee and related records' });
    } finally {
      client.release();
    }
  }

  try {
    const result = await pool.query(
      'DELETE FROM employees WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json({ message: 'Employee deleted', employee: result.rows[0] });
  } catch (err) {
    console.error("EXACT EMPLOYEE DELETE ERROR:", err);
    if (err.code === '23503') {
      // Foreign key violation — this employee still has related records
      // (leave requests, trainings, overtime, login account, etc.)
      return res.status(409).json({
        error: 'This employee has related records (leave requests, trainings, overtime, login account, or similar) and cannot be permanently deleted while those exist. Deactivate them instead, or remove their related records first.'
      });
    }
    res.status(500).json({ error: 'Error deleting employee' });
  }
});

// 9. Create or Update Login Credentials for an Employee
app.post('/api/employees/:id/account', async (req, res) => {
  const { id } = req.params;
  const { username, password, role } = req.body;

  try {
    const existing = await pool.query(
      'SELECT id FROM users WHERE employee_id = $1',
      [id]
    );

    let result;
    if (existing.rows.length > 0) {
      if (password && password.trim() !== '') {
        result = await pool.query(
          'UPDATE users SET username = $1, password = $2, role = $3 WHERE employee_id = $4 RETURNING id, username, password, role',
          [username, password, role, id]
        );
      } else {
        result = await pool.query(
          'UPDATE users SET username = $1, role = $2 WHERE employee_id = $3 RETURNING id, username, password, role',
          [username, role, id]
        );
      }
    } else {
      result = await pool.query(
        'INSERT INTO users (username, password, role, employee_id) VALUES ($1, $2, $3, $4) RETURNING id, username, password, role',
        [username, password, role, id]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT ACCOUNT SAVE ERROR:", err);
    res.status(500).json({ error: 'Error saving login credentials' });
  }
});

// 10. Upload/Replace Employee Documents
app.post('/api/employees/:id/documents', upload.fields([
  { name: 'id_document', maxCount: 1 },
  { name: 'employment_contract', maxCount: 1 },
  { name: 'rss_contract', maxCount: 1 }
]), async (req, res) => {
  const { id } = req.params;
  const files = req.files;

  try {
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (files.id_document) {
      updates.push(`id_document_path = $${paramIndex++}`);
      values.push('uploads/' + files.id_document[0].filename);
    }
    if (files.employment_contract) {
      updates.push(`employment_contract_path = $${paramIndex++}`);
      values.push('uploads/' + files.employment_contract[0].filename);
    }
    if (files.rss_contract) {
      updates.push(`rss_contract_path = $${paramIndex++}`);
      values.push('uploads/' + files.rss_contract[0].filename);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No files were uploaded' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE employees SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT DOCUMENT UPLOAD ERROR:", err);
    res.status(500).json({ error: 'Error uploading documents' });
  }
});

// 11. Get an Employee's Leave Balance + History (accrual-based, fixed entitlement totals)
app.get('/api/employees/:id/leave', async (req, res) => {
  const { id } = req.params;
  try {
    const empResult = await pool.query('SELECT start_date FROM employees WHERE id = $1', [id]);
    if (empResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    const startDate = empResult.rows[0].start_date;

    let monthsEmployed = 0;
    if (startDate) {
      const start = new Date(startDate);
      const now = new Date();
      monthsEmployed = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
      if (now.getDate() < start.getDate()) monthsEmployed -= 1;
      if (monthsEmployed < 0) monthsEmployed = 0;
    }

    const round2 = (n) => Math.round(n * 100) / 100;

    const paidAccrued = round2(Math.min(15, monthsEmployed * 1.25));
    const sickMonths = Math.max(0, monthsEmployed - 2);
    const sickAccrued = round2(Math.min(10, sickMonths * 0.83));

    const PAID_TOTAL = 15;
    const SICK_TOTAL = 10;
    const FAMILY_TOTAL = 3;

    const history = await pool.query(
      'SELECT * FROM leave_requests WHERE employee_id = $1 ORDER BY requested_at DESC',
      [id]
    );

    const types = ['Paid Leave', 'Sick Leave', 'Family Responsibility Leave', 'Unpaid Leave'];
    const usedByType = {};
    for (const type of types) {
      const usedResult = await pool.query(
        `SELECT COALESCE(SUM(days_requested), 0) AS used
         FROM leave_requests
         WHERE employee_id = $1 AND leave_type = $2 AND status = 'Approved'`,
        [id, type]
      );
      usedByType[type] = parseInt(usedResult.rows[0].used, 10);
    }

    const balances = {
      'Paid Leave': {
        entitlement: PAID_TOTAL,
        used: usedByType['Paid Leave'],
        remaining: round2(paidAccrued - usedByType['Paid Leave'])
      },
      'Sick Leave': {
        entitlement: SICK_TOTAL,
        used: usedByType['Sick Leave'],
        remaining: round2(sickAccrued - usedByType['Sick Leave'])
      },
      'Family Responsibility Leave': {
        entitlement: FAMILY_TOTAL,
        used: usedByType['Family Responsibility Leave'],
        remaining: FAMILY_TOTAL - usedByType['Family Responsibility Leave']
      },
      'Unpaid Leave': {
        entitlement: null,
        used: usedByType['Unpaid Leave'],
        remaining: null
      }
    };

    res.json({ balances, history: history.rows, start_date: startDate });
  } catch (err) {
    console.error("EXACT LEAVE FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching leave data' });
  }
});

// 11b. Get Custom Additions to the Monthly Leave Accrual Table
app.get('/api/employees/:id/leave-table-custom', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT custom_columns, custom_rows FROM leave_table_customizations WHERE employee_id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.json({ custom_columns: [], custom_rows: [] });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT CUSTOM TABLE FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching table customizations' });
  }
});

// 11c. Save Custom Additions to the Monthly Leave Accrual Table
app.put('/api/employees/:id/leave-table-custom', async (req, res) => {
  const { id } = req.params;
  const { custom_columns, custom_rows } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO leave_table_customizations (employee_id, custom_columns, custom_rows)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id) DO UPDATE SET custom_columns = $2, custom_rows = $3
       RETURNING *`,
      [id, JSON.stringify(custom_columns || []), JSON.stringify(custom_rows || [])]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT CUSTOM TABLE SAVE ERROR:", err);
    res.status(500).json({ error: 'Error saving table customizations' });
  }
});

// 12. Submit a New Leave Request
app.post('/api/employees/:id/leave', async (req, res) => {
  const { id } = req.params;
  const {
    leave_type, start_date, end_date, days_requested, reason,
    present_address, address_during_leave, contact_during_leave
  } = req.body;

  if (!leave_type || !start_date || !end_date || !days_requested) {
    return res.status(400).json({ error: 'Missing required leave fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO leave_requests
        (employee_id, leave_type, start_date, end_date, days_requested, reason,
         present_address, address_during_leave, contact_during_leave, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Pending')
       RETURNING *`,
      [id, leave_type, start_date, end_date, days_requested, reason || null,
       present_address || null, address_during_leave || null, contact_during_leave || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT LEAVE REQUEST ERROR:", err);
    res.status(500).json({ error: 'Error submitting leave request' });
  }
});

// 13. Get All Pending Leave Requests
app.get('/api/leave/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT leave_requests.*, employees.first_name, employees.last_name
       FROM leave_requests
       JOIN employees ON employees.id = leave_requests.employee_id
       WHERE leave_requests.status = 'Pending'
       ORDER BY leave_requests.requested_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT PENDING LEAVE FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching pending leave requests' });
  }
});

// 13b. Get ALL Leave Requests (for Inbox — Pending, Approved, and Rejected all stay visible)
app.get('/api/leave/all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT leave_requests.*, employees.first_name, employees.last_name
       FROM leave_requests
       JOIN employees ON employees.id = leave_requests.employee_id
       ORDER BY leave_requests.requested_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT ALL LEAVE FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching leave requests' });
  }
});

// 13c. Mark a Leave Request as Read
app.patch('/api/leave/:requestId/read', async (req, res) => {
  const { requestId } = req.params;
  try {
    const result = await pool.query(
      `UPDATE leave_requests SET is_read = TRUE WHERE id = $1 RETURNING *`,
      [requestId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT MARK READ ERROR:", err);
    res.status(500).json({ error: 'Error marking as read' });
  }
});

// 14. Approve a Leave Request
app.patch('/api/leave/:requestId/approve', async (req, res) => {
  const { requestId } = req.params;
  try {
    const result = await pool.query(
      `UPDATE leave_requests SET status = 'Approved', decided_at = NOW() WHERE id = $1 RETURNING *`,
      [requestId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Leave request not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT LEAVE APPROVE ERROR:", err);
    res.status(500).json({ error: 'Error approving leave request' });
  }
});

// 15. Reject a Leave Request (with optional comment explaining why)
app.patch('/api/leave/:requestId/reject', async (req, res) => {
  const { requestId } = req.params;
  const { comment } = req.body;
  try {
    const result = await pool.query(
      `UPDATE leave_requests SET status = 'Rejected', decided_at = NOW(), admin_comment = $2 WHERE id = $1 RETURNING *`,
      [requestId, comment || null]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Leave request not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT LEAVE REJECT ERROR:", err);
    res.status(500).json({ error: 'Error rejecting leave request' });
  }
});

// ============ TRAININGS ============

app.get('/api/trainings', async (req, res) => {
  const { employee_id, owner_id } = req.query;
  try {
    let query = 'SELECT * FROM trainings';
    let params = [];
    if (owner_id) {
      query += ' WHERE created_by = $1';
      params.push(owner_id);
    }
    query += ' ORDER BY category, created_at DESC';
    const trainingsResult = await pool.query(query, params);
    const trainings = trainingsResult.rows;

    if (employee_id) {
      const completedResult = await pool.query(
        'SELECT training_id FROM training_completions WHERE employee_id = $1',
        [employee_id]
      );
      const completedIds = new Set(completedResult.rows.map(r => r.training_id));
      trainings.forEach(t => { t.completed = completedIds.has(t.id); });
    }

    res.json(trainings);
  } catch (err) {
    console.error("EXACT TRAININGS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching trainings' });
  }
});

app.get('/api/training-categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM training_categories ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT TRAINING CATEGORIES FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching training categories' });
  }
});

app.post('/api/training-categories', async (req, res) => {
  const { name, created_by } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await pool.query(
      `INSERT INTO training_categories (name, created_by)
       VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING *`,
      [name.trim(), created_by || null]
    );
    res.status(201).json(result.rows[0] || { name: name.trim() });
  } catch (err) {
    console.error("EXACT TRAINING CATEGORY CREATE ERROR:", err);
    res.status(500).json({ error: 'Error adding training category' });
  }
});

app.patch('/api/training-categories/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const oldResult = await pool.query('SELECT name FROM training_categories WHERE id = $1', [id]);
    if (oldResult.rows.length === 0) {
      return res.status(404).json({ error: 'Training topic not found' });
    }
    const oldName = oldResult.rows[0].name;
    const newName = name.trim();

    await pool.query('UPDATE training_categories SET name = $2 WHERE id = $1', [id, newName]);
    await pool.query('UPDATE trainings SET category = $2 WHERE category = $1', [oldName, newName]);
    await pool.query('UPDATE training_category_columns SET category = $2 WHERE category = $1', [oldName, newName]);

    res.json({ id, name: newName });
  } catch (err) {
    console.error("EXACT TRAINING CATEGORY RENAME ERROR:", err);
    res.status(500).json({ error: 'Error renaming training topic' });
  }
});

app.delete('/api/training-categories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const catResult = await pool.query('SELECT name FROM training_categories WHERE id = $1', [id]);
    if (catResult.rows.length === 0) {
      return res.status(404).json({ error: 'Training topic not found' });
    }
    const name = catResult.rows[0].name;

    await pool.query('DELETE FROM training_category_columns WHERE category = $1', [name]);
    await pool.query('DELETE FROM trainings WHERE category = $1', [name]);
    await pool.query('DELETE FROM training_categories WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (err) {
    console.error("EXACT TRAINING CATEGORY DELETE ERROR:", err);
    res.status(500).json({ error: 'Error deleting training topic' });
  }
});

app.post('/api/trainings', async (req, res) => {
  const { category, title, training_date, link, description, created_by } = req.body;
  if (!category || !title) {
    return res.status(400).json({ error: 'Category and title are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO trainings (category, title, training_date, link, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [category, title, training_date || null, link || null, description || null, created_by || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT TRAINING CREATE ERROR:", err);
    res.status(500).json({ error: 'Error creating training' });
  }
});

app.patch('/api/trainings/:id', async (req, res) => {
  const { id } = req.params;
  const { title, training_date } = req.body;
  try {
    const result = await pool.query(
      `UPDATE trainings SET title = $2, training_date = $3 WHERE id = $1 RETURNING *`,
      [id, title, training_date || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT TRAINING UPDATE ERROR:", err);
    res.status(500).json({ error: 'Error updating training' });
  }
});

app.delete('/api/trainings/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM trainings WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT TRAINING DELETE ERROR:", err);
    res.status(500).json({ error: 'Error deleting training' });
  }
});

app.post('/api/trainings/:id/complete', async (req, res) => {
  const { id } = req.params;
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
  try {
    await pool.query(
      `INSERT INTO training_completions (training_id, employee_id, completed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (training_id, employee_id) DO NOTHING`,
      [id, employee_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT TRAINING COMPLETE ERROR:", err);
    res.status(500).json({ error: 'Error marking training complete' });
  }
});

app.delete('/api/trainings/:id/complete/:employeeId', async (req, res) => {
  const { id, employeeId } = req.params;
  try {
    await pool.query(
      'DELETE FROM training_completions WHERE training_id = $1 AND employee_id = $2',
      [id, employeeId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT TRAINING UNCOMPLETE ERROR:", err);
    res.status(500).json({ error: 'Error unmarking training' });
  }
});

app.get('/api/training-columns', async (req, res) => {
  const { category } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM training_category_columns WHERE category = $1 ORDER BY id ASC',
      [category]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT TRAINING COLUMNS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching training columns' });
  }
});

app.post('/api/training-columns', async (req, res) => {
  const { category, column_name } = req.body;
  if (!category || !column_name) {
    return res.status(400).json({ error: 'category and column_name are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO training_category_columns (category, column_name)
       VALUES ($1, $2)
       ON CONFLICT (category, column_name) DO NOTHING
       RETURNING *`,
      [category, column_name]
    );
    res.status(201).json(result.rows[0] || { category, column_name });
  } catch (err) {
    console.error("EXACT TRAINING COLUMN CREATE ERROR:", err);
    res.status(500).json({ error: 'Error adding training column' });
  }
});

app.patch('/api/training-columns/:id', async (req, res) => {
  const { id } = req.params;
  const { column_name } = req.body;
  if (!column_name) return res.status(400).json({ error: 'column_name is required' });
  try {
    const result = await pool.query(
      'UPDATE training_category_columns SET column_name = $2 WHERE id = $1 RETURNING *',
      [id, column_name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT TRAINING COLUMN RENAME ERROR:", err);
    res.status(500).json({ error: 'Error renaming column' });
  }
});

app.delete('/api/training-columns/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM training_category_columns WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT TRAINING COLUMN DELETE ERROR:", err);
    res.status(500).json({ error: 'Error removing training column' });
  }
});

app.patch('/api/trainings/:id/extra', async (req, res) => {
  const { id } = req.params;
  const { column_name, value } = req.body;
  try {
    const result = await pool.query(
      `UPDATE trainings
       SET extra_data = jsonb_set(COALESCE(extra_data, '{}'::jsonb), ARRAY[$2], to_jsonb($3::text))
       WHERE id = $1
       RETURNING *`,
      [id, column_name, value || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT TRAINING CELL SAVE ERROR:", err);
    res.status(500).json({ error: 'Error saving training cell' });
  }
});

// RSS In-House Training weekly task list (Mon-Fri), stored in trainings.extra_data.weekly_tasks
app.get('/api/trainings/:id/weekly-tasks', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT extra_data FROM trainings WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Training not found' });
    }
    const weekly = (result.rows[0].extra_data && result.rows[0].extra_data.weekly_tasks) || null;
    res.json(weekly || { week_start: null, week_end: null, week_label: '', days: {} });
  } catch (err) {
    console.error("EXACT WEEKLY TASKS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching weekly tasks' });
  }
});

app.put('/api/trainings/:id/weekly-tasks', async (req, res) => {
  const { id } = req.params;
  const { week_start, week_end, week_label, days } = req.body;
  if (!week_start || !week_end || !days) {
    return res.status(400).json({ error: 'week_start, week_end and days are required' });
  }
  try {
    const weeklyData = { week_start, week_end, week_label: week_label || '', days };
    const result = await pool.query(
      `UPDATE trainings
       SET extra_data = jsonb_set(COALESCE(extra_data, '{}'::jsonb), ARRAY['weekly_tasks'], $2::jsonb),
           training_date = $3
       WHERE id = $1
       RETURNING *`,
      [id, JSON.stringify(weeklyData), week_start]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Training not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT WEEKLY TASKS SAVE ERROR:", err);
    res.status(500).json({ error: 'Error saving weekly tasks' });
  }
});

app.get('/api/trainings/:id/tasks', async (req, res) => {
  const { id } = req.params;
  const { employee_id } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM training_tasks WHERE training_id = $1 AND employee_id = $2 ORDER BY id ASC',
      [id, employee_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT TRAINING TASKS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching training tasks' });
  }
});

app.get('/api/trainings/:id/progress', async (req, res) => {
  const { id } = req.params;
  const { employee_id } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM training_progress WHERE training_id = $1 AND employee_id = $2',
      [id, employee_id]
    );
    if (result.rows.length === 0) {
      return res.json({ percentage: 0, completed_date: null, document_path: null });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT TRAINING PROGRESS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching training progress' });
  }
});

app.put('/api/trainings/:id/progress', async (req, res) => {
  const { id } = req.params;
  const { employee_id, percentage } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
  const pct = Math.max(0, Math.min(100, parseInt(percentage, 10) || 0));
  try {
    const trainingResult = await pool.query('SELECT category FROM trainings WHERE id = $1', [id]);
    const isPresentation = trainingResult.rows.length > 0 && trainingResult.rows[0].category === 'Presentation Day Topics';

    const completedDate = pct >= 100 ? new Date().toISOString().split('T')[0] : null;
    const result = await pool.query(
      `INSERT INTO training_progress (training_id, employee_id, percentage, completed_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (training_id, employee_id) DO UPDATE SET percentage = $3, completed_date = $4
       RETURNING *`,
      [id, employee_id, pct, completedDate]
    );

    if (pct >= 100 && !isPresentation) {
      await pool.query(
        `INSERT INTO training_completions (training_id, employee_id, completed_at)
         VALUES ($1, $2, NOW()) ON CONFLICT (training_id, employee_id) DO NOTHING`,
        [id, employee_id]
      );
    } else if (pct < 100) {
      await pool.query(
        'DELETE FROM training_completions WHERE training_id = $1 AND employee_id = $2',
        [id, employee_id]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT TRAINING PROGRESS SAVE ERROR:", err);
    res.status(500).json({ error: 'Error saving training progress' });
  }
});

app.post('/api/trainings/:id/document', upload.single('document'), async (req, res) => {
  const { id } = req.params;
  const { employee_id } = req.body;
  if (!employee_id || !req.file) {
    return res.status(400).json({ error: 'employee_id and document file are required' });
  }
  try {
    const filePath = 'uploads/' + req.file.filename;
    const result = await pool.query(
      `UPDATE training_progress SET document_path = $3 WHERE training_id = $1 AND employee_id = $2 RETURNING *`,
      [id, employee_id, filePath]
    );

    let progressRow;
    if (result.rows.length === 0) {
      const insertResult = await pool.query(
        `INSERT INTO training_progress (training_id, employee_id, percentage, completed_date, document_path)
         VALUES ($1, $2, 100, $3, $4) RETURNING *`,
        [id, employee_id, new Date().toISOString().split('T')[0], filePath]
      );
      progressRow = insertResult.rows[0];
    } else {
      progressRow = result.rows[0];
    }

    await pool.query(
      `INSERT INTO training_completions (training_id, employee_id, completed_at)
       VALUES ($1, $2, NOW()) ON CONFLICT (training_id, employee_id) DO NOTHING`,
      [id, employee_id]
    );

    res.json(progressRow);
  } catch (err) {
    console.error("EXACT PRESENTATION DOC UPLOAD ERROR:", err);
    res.status(500).json({ error: 'Error uploading presentation document' });
  }
});

// ============ TIMESHEETS / OVERTIME ============

app.get('/api/employees/:id/overtime', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT oe.*,
              COALESCE(SUM(ot.minutes_taken), 0) AS minutes_taken_total,
              COALESCE(
                json_agg(
                  json_build_object('id', ot.id, 'minutes_taken', ot.minutes_taken, 'date_taken', ot.date_taken, 'note', ot.note)
                  ORDER BY ot.date_taken
                ) FILTER (WHERE ot.id IS NOT NULL),
                '[]'
              ) AS takings
       FROM overtime_entries oe
       LEFT JOIN overtime_takings ot ON ot.overtime_entry_id = oe.id
       WHERE oe.employee_id = $1
       GROUP BY oe.id
       ORDER BY oe.date_worked DESC, oe.id DESC`,
      [id]
    );
    const rows = result.rows.map(r => ({
      ...r,
      minutes_taken_total: parseInt(r.minutes_taken_total, 10),
      minutes_remaining: r.minutes_worked - parseInt(r.minutes_taken_total, 10)
    }));
    res.json(rows);
  } catch (err) {
    console.error("EXACT OVERTIME FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching overtime entries' });
  }
});

app.post('/api/employees/:id/overtime', async (req, res) => {
  const { id } = req.params;
  const { minutes_worked, date_worked } = req.body;
  if (!minutes_worked || !date_worked) {
    return res.status(400).json({ error: 'minutes_worked and date_worked are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO overtime_entries (employee_id, minutes_worked, date_worked)
       VALUES ($1, $2, $3) RETURNING *`,
      [id, minutes_worked, date_worked]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT OVERTIME CREATE ERROR:", err);
    res.status(500).json({ error: 'Error adding overtime entry' });
  }
});

app.patch('/api/overtime/:entryId', async (req, res) => {
  const { entryId } = req.params;
  const { minutes_worked, date_worked } = req.body;
  try {
    const result = await pool.query(
      `UPDATE overtime_entries SET minutes_worked = $2, date_worked = $3 WHERE id = $1 RETURNING *`,
      [entryId, minutes_worked, date_worked]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT OVERTIME UPDATE ERROR:", err);
    res.status(500).json({ error: 'Error updating overtime entry' });
  }
});

app.delete('/api/overtime/:entryId', async (req, res) => {
  const { entryId } = req.params;
  try {
    await pool.query('DELETE FROM overtime_entries WHERE id = $1', [entryId]);
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT OVERTIME DELETE ERROR:", err);
    res.status(500).json({ error: 'Error deleting overtime entry' });
  }
});

app.get('/api/overtime/:entryId/takings', async (req, res) => {
  const { entryId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM overtime_takings WHERE overtime_entry_id = $1 ORDER BY date_taken DESC, id DESC',
      [entryId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT OVERTIME TAKINGS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching overtime takings' });
  }
});

app.post('/api/overtime/:entryId/takings', async (req, res) => {
  const { entryId } = req.params;
  const { minutes_taken, date_taken, note } = req.body;
  if (!minutes_taken || !date_taken) {
    return res.status(400).json({ error: 'minutes_taken and date_taken are required' });
  }
  try {
    const entryResult = await pool.query('SELECT minutes_worked FROM overtime_entries WHERE id = $1', [entryId]);
    if (entryResult.rows.length === 0) {
      return res.status(404).json({ error: 'Overtime entry not found' });
    }
    const totalWorked = entryResult.rows[0].minutes_worked;

    const takenResult = await pool.query(
      'SELECT COALESCE(SUM(minutes_taken), 0) AS total FROM overtime_takings WHERE overtime_entry_id = $1',
      [entryId]
    );
    const alreadyTaken = parseInt(takenResult.rows[0].total, 10);
    const remaining = totalWorked - alreadyTaken;

    if (minutes_taken > remaining) {
      return res.status(400).json({ error: `Only ${remaining} minutes remaining on this overtime entry` });
    }

    const result = await pool.query(
      `INSERT INTO overtime_takings (overtime_entry_id, minutes_taken, date_taken, note)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [entryId, minutes_taken, date_taken, note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT OVERTIME TAKING CREATE ERROR:", err);
    res.status(500).json({ error: 'Error recording overtime taking' });
  }
});

app.delete('/api/overtime-takings/:takingId', async (req, res) => {
  const { takingId } = req.params;
  try {
    await pool.query('DELETE FROM overtime_takings WHERE id = $1', [takingId]);
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT OVERTIME TAKING DELETE ERROR:", err);
    res.status(500).json({ error: 'Error removing overtime taking' });
  }
});

// ============ RSS TRAINING REGISTER ============

app.get('/api/rss-training-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rss_training_types ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT RSS TRAINING TYPES FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching training types' });
  }
});

app.post('/api/rss-training-types', async (req, res) => {
  const { name, prefix, unit_standard, nqf_level, credits } = req.body;
  if (!name || !prefix) return res.status(400).json({ error: 'Name and prefix are required' });
  try {
    const result = await pool.query(
      `INSERT INTO rss_training_types (name, prefix, unit_standard, nqf_level, credits)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO NOTHING
       RETURNING *`,
      [name.trim(), prefix.trim().toUpperCase(), unit_standard || null, nqf_level || null, credits || null]
    );
    res.status(201).json(result.rows[0] || { name });
  } catch (err) {
    console.error("EXACT RSS TRAINING TYPE CREATE ERROR:", err);
    res.status(500).json({ error: 'Error creating training type' });
  }
});

app.patch('/api/rss-training-types/:id', async (req, res) => {
  const { id } = req.params;
  const { name, prefix, unit_standard, nqf_level, credits } = req.body;
  try {
    const result = await pool.query(
      `UPDATE rss_training_types SET name=$2, prefix=$3, unit_standard=$4, nqf_level=$5, credits=$6 WHERE id=$1 RETURNING *`,
      [id, name, prefix, unit_standard || null, nqf_level || null, credits || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT RSS TRAINING TYPE UPDATE ERROR:", err);
    res.status(500).json({ error: 'Error updating training type' });
  }
});

app.delete('/api/rss-training-types/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM rss_training_types WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT RSS TRAINING TYPE DELETE ERROR:", err);
    res.status(500).json({ error: 'Error deleting training type' });
  }
});

app.get('/api/rss-learners', async (req, res) => {
  const { name, year, month, client, expired } = req.query;
  try {
    let query = 'SELECT * FROM rss_training_learners WHERE 1=1';
    const params = [];
    let idx = 1;

    if (name) {
      query += ` AND (first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR id_number ILIKE $${idx})`;
      params.push(`%${name}%`);
      idx++;
    }
    if (year) {
      query += ` AND EXTRACT(YEAR FROM date_of_training) = $${idx}`;
      params.push(year);
      idx++;
    }
    if (month) {
      query += ` AND EXTRACT(MONTH FROM date_of_training) = $${idx}`;
      params.push(month);
      idx++;
    }
    if (client) {
      query += ` AND client ILIKE $${idx}`;
      params.push(`%${client}%`);
      idx++;
    }
    if (expired === 'true') {
      query += ` AND valid_until IS NOT NULL AND valid_until < CURRENT_DATE`;
    }

    query += ' ORDER BY date_of_training DESC, id DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT RSS LEARNERS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching learners' });
  }
});

app.get('/api/rss-learners/summary', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT training_type, COUNT(*) AS total FROM rss_training_learners GROUP BY training_type'
    );
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT RSS LEARNERS SUMMARY ERROR:", err);
    res.status(500).json({ error: 'Error fetching summary' });
  }
});

// Register a new learner — certificate number only generated when Result is Passed
app.post('/api/rss-learners', upload.fields([
  { name: 'id_document', maxCount: 1 },
  { name: 'marked_test', maxCount: 1 },
  { name: 'training_register', maxCount: 1 }
]), async (req, res) => {
  const {
    first_name, last_name, id_number, training_type, client,
    date_of_training, valid_until, passed, assessor_name, created_by
  } = req.body;

  if (!first_name || !last_name || !training_type) {
    return res.status(400).json({ error: 'First name, last name, and training type are required' });
  }

  const hasPassed = passed === 'true';

  try {
    let certificate_number = null;
    let typeRow = {};

    const typeResult = await pool.query('SELECT prefix, unit_standard, nqf_level, credits FROM rss_training_types WHERE name = $1', [training_type]);
    typeRow = typeResult.rows[0] || {};

    // Only a passed result generates a certificate number
    if (hasPassed) {
      const year = date_of_training ? new Date(date_of_training).getFullYear() : new Date().getFullYear();

      const counterResult = await pool.query(
        `INSERT INTO rss_certificate_counters (training_type, year, last_number)
         VALUES ($1, $2, 1)
         ON CONFLICT (training_type, year) DO UPDATE SET last_number = rss_certificate_counters.last_number + 1
         RETURNING last_number`,
        [training_type, year]
      );
      const seq = counterResult.rows[0].last_number;
      const prefix = typeRow.prefix || training_type.substring(0, 2).toUpperCase();
      certificate_number = `${prefix}${year}/${String(seq).padStart(3, '0')}`;
    }

    const files = req.files || {};
    const idDocPath = files.id_document ? 'uploads/' + files.id_document[0].filename : null;
    const markedTestPath = files.marked_test ? 'uploads/' + files.marked_test[0].filename : null;
    const registerPath = files.training_register ? 'uploads/' + files.training_register[0].filename : null;

    const result = await pool.query(
      `INSERT INTO rss_training_learners
        (first_name, last_name, id_number, training_type, client, date_of_training, valid_until, passed, certificate_number, id_document_path, marked_test_path, training_register_path, created_by, unit_standard, nqf_level, credits, assessor_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [first_name, last_name, id_number || null, training_type, client || null, date_of_training || null, valid_until || null,
       hasPassed, certificate_number, idDocPath, markedTestPath, registerPath, created_by || null,
       typeRow.unit_standard || null, typeRow.nqf_level || null, typeRow.credits || null, assessor_name || 'M. Reginald']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT RSS LEARNER CREATE ERROR:", err);
    res.status(500).json({ error: 'Error registering learner' });
  }
});

// Update a learner's core details — clears certificate number if changed to Failed
app.patch('/api/rss-learners/:id', async (req, res) => {
  const { id } = req.params;
  const {
    first_name, last_name, id_number, training_type, client,
    date_of_training, valid_until, passed, assessor_name
  } = req.body;
  const hasPassed = passed === true || passed === 'true';
  try {
    if (!hasPassed) {
      await pool.query('UPDATE rss_training_learners SET certificate_number = NULL WHERE id = $1', [id]);
    }

    const result = await pool.query(
      `UPDATE rss_training_learners SET
        first_name=$2, last_name=$3, id_number=$4, training_type=$5, client=$6,
        date_of_training=$7, valid_until=$8, passed=$9, assessor_name=$10
       WHERE id=$1 RETURNING *`,
      [id, first_name, last_name, id_number || null, training_type, client || null,
       date_of_training || null, valid_until || null, hasPassed, assessor_name || 'M. Reginald']
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT RSS LEARNER UPDATE ERROR:", err);
    res.status(500).json({ error: 'Error updating learner' });
  }
});

app.post('/api/rss-learners/:id/documents', upload.fields([
  { name: 'id_document', maxCount: 1 },
  { name: 'marked_test', maxCount: 1 },
  { name: 'training_register', maxCount: 1 }
]), async (req, res) => {
  const { id } = req.params;
  const files = req.files || {};
  try {
    const updates = [];
    const values = [];
    let idx = 1;
    if (files.id_document) { updates.push(`id_document_path = $${idx++}`); values.push('uploads/' + files.id_document[0].filename); }
    if (files.marked_test) { updates.push(`marked_test_path = $${idx++}`); values.push('uploads/' + files.marked_test[0].filename); }
    if (files.training_register) { updates.push(`training_register_path = $${idx++}`); values.push('uploads/' + files.training_register[0].filename); }
    if (updates.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    values.push(id);
    const result = await pool.query(
      `UPDATE rss_training_learners SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT RSS LEARNER DOC UPLOAD ERROR:", err);
    res.status(500).json({ error: 'Error uploading documents' });
  }
});

app.delete('/api/rss-learners/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM rss_training_learners WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT RSS LEARNER DELETE ERROR:", err);
    res.status(500).json({ error: 'Error deleting learner' });
  }
});

app.patch('/api/rss-learners/:id/signature', async (req, res) => {
  const { id } = req.params;
  const { signature_data } = req.body;
  try {
    const result = await pool.query(
      'UPDATE rss_training_learners SET signature_data = $2 WHERE id = $1 RETURNING *',
      [id, signature_data]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT SIGNATURE SAVE ERROR:", err);
    res.status(500).json({ error: 'Error saving signature' });
  }
});

// ============ RSS TRAINING MANUALS ============

app.get('/api/rss-manuals', async (req, res) => {
  const { training_type } = req.query;
  try {
    let query = 'SELECT * FROM rss_training_manuals';
    let params = [];
    if (training_type) {
      query += ' WHERE training_type = $1';
      params.push(training_type);
    }
    query += ' ORDER BY uploaded_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT RSS MANUALS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching manuals' });
  }
});

app.post('/api/rss-manuals', upload.single('manual'), async (req, res) => {
  const { training_type, uploaded_by } = req.body;
  if (!training_type || !req.file) {
    return res.status(400).json({ error: 'training_type and a file are required' });
  }
  try {
    const filePath = 'uploads/' + req.file.filename;
    const result = await pool.query(
      `INSERT INTO rss_training_manuals (training_type, file_name, file_path, uploaded_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [training_type, req.file.originalname, filePath, uploaded_by || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT RSS MANUAL CREATE ERROR:", err);
    res.status(500).json({ error: 'Error uploading manual' });
  }
});

app.delete('/api/rss-manuals/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM rss_training_manuals WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT RSS MANUAL DELETE ERROR:", err);
    res.status(500).json({ error: 'Error deleting manual' });
  }
});

// ============ TIMESHEET SPREADSHEET UPLOAD ============
//
// This clock machine (the one that produces files like "07Summary.xls") exports
// a multi-sheet workbook. The sheet we actually want is called "Logs" and looks
// like this once you dump it as a grid:
//
//   Row 0: "List of Logs"
//   Row 1: (blank)
//   Row 2: "Duration:", "", "2026/07/01 ~ 07/31\t( rss )"   <- gives us year+month
//   Row 3: 1, 2, 3, 4, ... 31                                <- day-of-month headers, one per column
//   Row 4: "No:", "", "1", ..., "Name:", "", "milly", ..., "Dept:", "", ""
//   Row 5: "07:14\n", "", "", ...                            <- that employee's punches for the month
//   Row 6: "No:", "", "2", ..., "Name:", "", "bokamoso", ...
//   Row 7: punches for employee 2
//   ... repeats to the end of the sheet
//
// Each day's cell can hold more than one punch, newline-separated (e.g. "08:01\n15:07\n").
// The FIRST punch in a cell is treated as time in, the LAST as time out (if there's
// more than one) — any punches in between are ignored, since this machine doesn't
// distinguish break-out/break-in punches from a plain clock-in/clock-out pair.
//
// The sheet only gives a first name per block (lowercase, sometimes misspelled, and
// sometimes it's actually someone's middle or last name instead of their first name).
// There's no reliable ID to join on, so we fuzzy-match each block's name against every
// employee's first_name AND last_name and take the closest match, using a normalized
// edit-distance so short and long names are judged fairly. Matches that aren't close
// enough are skipped and reported back to the user instead of being guessed at.
//
// If a workbook doesn't have a "Logs" sheet at all (e.g. someone uploads the older,
// simple date/name/Surname/Time in/Time out spreadsheet format this endpoint used to
// support), we fall back to that simpler parser so nothing that worked before breaks.

// ---- Levenshtein edit distance, used for fuzzy name matching ----
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,      // deletion
        currRow[j - 1] + 1,  // insertion
        prevRow[j - 1] + cost // substitution
      );
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

// Finds the employee whose first_name or last_name is the closest fuzzy match to
// `rawName` (a single lowercase name off the timesheet, e.g. "olwetu" or "makie").
// Returns { employee, matchedOn, score } or null if nothing is close enough.
function findClosestEmployee(rawName, employees) {
  const target = String(rawName || '').trim().toLowerCase();
  if (!target) return null;

  let best = null;

  for (const emp of employees) {
    const candidates = [
      { field: 'first_name', value: (emp.first_name || '').trim().toLowerCase() },
      { field: 'last_name', value: (emp.last_name || '').trim().toLowerCase() }
    ];

    for (const { field, value } of candidates) {
      if (!value) continue;

      let rawDistance;
      if (value === target) {
        rawDistance = 0;
      } else if (value.startsWith(target) || target.startsWith(value)) {
        // Handles short/truncated forms, e.g. "resego" vs "resego mokoena" would
        // only apply if last_name matching used full names — for first-name-only
        // truncations like "success" vs "succes" this still falls through to
        // Levenshtein below, but exact-prefix cases (nicknames) get rewarded here.
        rawDistance = 0.5;
      } else {
        rawDistance = levenshteinDistance(value, target);
      }

      // Normalize by the longer of the two strings so a 1-letter typo on a short
      // name ("makie" vs "maki") isn't scored the same as a 1-letter typo on a
      // long one — both should count as "close", but on raw distance alone a
      // long name gets an unfair advantage.
      const score = rawDistance / Math.max(value.length, target.length, 1);

      if (!best || score < best.score) {
        best = { employee: emp, matchedOn: field, score };
      }
    }
  }

  // Accept only reasonably close matches. 0.34 allows roughly one typo'd
  // character per three letters (covers real-world misspellings like
  // "olwetu" -> "olwethu" or "succes" -> "success") without matching two
  // genuinely different names to each other.
  if (best && best.score <= 0.34) return best;
  return null;
}

// Reads every cell in a sheet as a plain grid (array of arrays of strings),
// which is much easier to reason about than SheetJS's default row-object mode
// for a sheet whose layout isn't a simple one-header-row table.
function sheetToGrid(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true });
}

// Finds the "Logs" sheet (case-insensitive by name; falls back to scanning every
// sheet for the "No:" / "Name:" block pattern in case the machine names it
// differently on a different export).
function findLogsSheetName(workbook) {
  const exact = workbook.SheetNames.find(n => n.trim().toLowerCase() === 'logs');
  if (exact) return exact;

  return workbook.SheetNames.find(n => {
    const grid = sheetToGrid(workbook.Sheets[n]);
    return grid.some(row => row.some(cell => String(cell).trim() === 'No:'));
  }) || null;
}

// Pulls a labelled value out of a header row, e.g. given a row containing
// ["No:", "", "1", ..., "Name:", "", "milly", ...] and label "Name:", returns "milly".
// Scans forward from the label for the first non-blank cell rather than assuming
// a fixed offset, since blank spacer columns can vary.
function extractLabelledValue(row, label) {
  for (let i = 0; i < row.length; i++) {
    if (String(row[i]).trim() === label) {
      for (let j = i + 1; j < row.length; j++) {
        const v = String(row[j]).trim();
        if (v !== '') return v;
      }
      return '';
    }
  }
  return '';
}

// Pulls the year and month out of the "Duration:" row, e.g.
// "2026/07/01 ~ 07/31\t( rss )" -> { year: 2026, month: 7 }
function extractYearMonth(grid) {
  for (const row of grid) {
    for (const cell of row) {
      const m = String(cell).match(/(\d{4})\/(\d{2})\/\d{2}\s*~\s*\d{2}\/\d{2}/);
      if (m) return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
    }
  }
  return null;
}

// Finds the row that maps each column to a day-of-month number (1, 2, 3, ... up
// to 31), and returns { rowIndex, colToDay } where colToDay maps column index -> day.
function findDayHeaderRow(grid) {
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    const firstThree = [row[0], row[1], row[2]].map(c => String(c).trim());
    if (firstThree[0] === '1' && firstThree[1] === '2' && firstThree[2] === '3') {
      const colToDay = {};
      row.forEach((cell, colIdx) => {
        const n = parseInt(String(cell).trim(), 10);
        if (n >= 1 && n <= 31) colToDay[colIdx] = n;
      });
      return { rowIndex: i, colToDay };
    }
  }
  return null;
}

// Splits a punch cell like "08:01\n15:07\n" into { time_in, time_out }.
// First punch = time in. Last punch (if there's more than one) = time out.
// Anything in between is ignored — this clock export doesn't distinguish
// break punches from clock-in/clock-out punches.
function splitPunches(cellValue) {
  const punches = String(cellValue)
    .split('\n')
    .map(p => p.trim())
    .filter(p => /^\d{1,2}:\d{2}/.test(p));
  if (punches.length === 0) return null;
  return {
    time_in: punches[0].slice(0, 5),
    time_out: punches.length > 1 ? punches[punches.length - 1].slice(0, 5) : null
  };
}

// Parses the "Logs" sheet into a flat list of
// { raw_name, employee_id, entry_date, time_in, time_out } rows, plus a
// per-block match summary so the caller can report exactly who matched to whom.
function parseClockMachineLogs(sheet, employees) {
  const grid = sheetToGrid(sheet);
  const yearMonth = extractYearMonth(grid);
  const dayHeader = findDayHeaderRow(grid);

  if (!yearMonth || !dayHeader) {
    throw new Error('Could not find the "Duration" date range or the day-of-month header row in the Logs sheet.');
  }

  const entries = [];
  const matchSummary = [];

  for (let i = dayHeader.rowIndex + 1; i < grid.length; i++) {
    const row = grid[i];
    const hasNoLabel = row.some(cell => String(cell).trim() === 'No:');
    if (!hasNoLabel) continue; // not a header row for a new employee block

    const rawName = extractLabelledValue(row, 'Name:');
    const dataRow = grid[i + 1] || [];
    const match = rawName ? findClosestEmployee(rawName, employees) : null;

    matchSummary.push({
      raw_name: rawName || '(blank)',
      matched_employee: match ? `${match.employee.first_name} ${match.employee.last_name}`.trim() : null,
      employee_id: match ? match.employee.id : null
    });

    if (match) {
      for (const [colIdxStr, day] of Object.entries(dayHeader.colToDay)) {
        const colIdx = parseInt(colIdxStr, 10);
        const punches = splitPunches(dataRow[colIdx]);
        if (!punches) continue;

        const entry_date = `${yearMonth.year}-${String(yearMonth.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        entries.push({
          raw_name: rawName,
          employee_id: match.employee.id,
          entry_date,
          time_in: punches.time_in,
          time_out: punches.time_out
        });
      }
    }

    i++; // skip the data row we just consumed
  }

  return { entries, matchSummary };
}

// ---- Legacy flat-spreadsheet fallback (date, name, Surname, Time in, Time out) ----

function parseSheetDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Clock machine format: DD.MM.YYYY
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Fallback for other common formats (e.g. already ISO, or mm/dd/yyyy)
  const parsed = new Date(s);
  if (!isNaN(parsed)) return parsed.toISOString().split('T')[0];
  return null;
}

function parseSheetTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return null;
}

function parseFlatTimesheet(workbook, employees) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

  const empMap = new Map();
  employees.forEach(e => {
    const key = `${(e.first_name || '').trim().toLowerCase()}|${(e.last_name || '').trim().toLowerCase()}`;
    empMap.set(key, e.id);
  });

  const entries = [];
  const matchSummary = [];

  for (const row of rows) {
    const norm = {};
    Object.keys(row).forEach(k => { norm[k.trim().toLowerCase()] = row[k]; });

    const name = (norm['name'] || '').toString().trim();
    const surname = (norm['surname'] || '').toString().trim();
    if (!name && !surname) continue; // blank row

    const entry_date = parseSheetDate(norm['date']);
    const time_in = parseSheetTime(norm['time in']);
    const time_out = parseSheetTime(norm['time out']);

    const key = `${name.toLowerCase()}|${surname.toLowerCase()}`;
    const employee_id = empMap.get(key) || null;
    const rawName = `${name} ${surname}`.trim();

    matchSummary.push({ raw_name: rawName, matched_employee: employee_id ? rawName : null, employee_id });

    if (!employee_id || !entry_date) continue;

    entries.push({ raw_name: rawName, employee_id, entry_date, time_in, time_out });
  }

  return { entries, matchSummary };
}

function minutesBetween(timeIn, timeOut) {
  if (!timeIn || !timeOut) return null;
  const [h1, m1] = timeIn.split(':').map(Number);
  const [h2, m2] = timeOut.split(':').map(Number);
  let diff = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (diff < 0) diff += 24 * 60; // handles a shift that crosses midnight
  return diff;
}

app.post('/api/timesheets/upload', memUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const bufferSize = req.file.buffer ? req.file.buffer.length : 0;
    console.log(`TIMESHEET UPLOAD: received "${req.file.originalname}" (${bufferSize} bytes)`);

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetNames = workbook.SheetNames || [];
    console.log('TIMESHEET UPLOAD: sheets found ->', sheetNames);

    // If XLSX couldn't extract any sheets at all, everything downstream would be
    // silently empty (0 inserted, 0 skipped, no error) — which is useless for
    // figuring out what went wrong. Fail loudly instead, with real diagnostics.
    if (sheetNames.length === 0) {
      return res.status(500).json({
        error: `The uploaded file ("${req.file.originalname}", ${bufferSize} bytes) could not be read as a spreadsheet — no sheets were found in it. This usually means the file is empty, corrupted, or isn't actually a valid .xlsx/.xls file (e.g. it was renamed from a different format). Try re-downloading the export directly from the clock machine and uploading that file unmodified.`,
        sheet_names: sheetNames,
        buffer_size: bufferSize
      });
    }

    const empResult = await pool.query('SELECT id, first_name, last_name FROM employees');
    const employees = empResult.rows;

    const logsSheetName = findLogsSheetName(workbook);
    console.log('TIMESHEET UPLOAD: "Logs" sheet resolved to ->', logsSheetName || '(not found, using fallback parser)');

    let entries, matchSummary;
    if (logsSheetName) {
      ({ entries, matchSummary } = parseClockMachineLogs(workbook.Sheets[logsSheetName], employees));
    } else {
      ({ entries, matchSummary } = parseFlatTimesheet(workbook, employees));
    }

    console.log(`TIMESHEET UPLOAD: parsed ${entries.length} punch entrie(s), ${matchSummary.length} name block(s)`);

    let inserted = 0;
    const skippedNames = [...new Set(
      matchSummary.filter(m => !m.employee_id).map(m => m.raw_name)
    )];

    for (const entry of entries) {
      const minutes_worked = minutesBetween(entry.time_in, entry.time_out);
      await pool.query(
        `INSERT INTO timesheet_entries (employee_id, entry_date, time_in, time_out, minutes_worked)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (employee_id, entry_date)
         DO UPDATE SET time_in = EXCLUDED.time_in, time_out = EXCLUDED.time_out, minutes_worked = EXCLUDED.minutes_worked`,
        [entry.employee_id, entry.entry_date, entry.time_in, entry.time_out, minutes_worked]
      );
      inserted++;
    }

    res.json({
      inserted,
      skipped: skippedNames.length,
      skipped_names: skippedNames,
      sheet_used: logsSheetName || sheetNames[0] || 'unknown',
      sheet_names: sheetNames,
      used_fallback_format: !logsSheetName,
      matches: matchSummary
    });
  } catch (err) {
    console.error('EXACT TIMESHEET UPLOAD ERROR:', err);
    res.status(500).json({ error: err.message || 'Failed to process timesheet file. Is it a valid spreadsheet export from the clock machine?' });
  }
});

app.patch('/api/timesheets/:id', async (req, res) => {
  const { id } = req.params;
  const { entry_date, time_in, time_out } = req.body;
  try {
    const minutes_worked = minutesBetween(time_in || null, time_out || null);
    const result = await pool.query(
      `UPDATE timesheet_entries SET entry_date = $2, time_in = $3, time_out = $4, minutes_worked = $5
       WHERE id = $1 RETURNING *`,
      [id, entry_date, time_in || null, time_out || null, minutes_worked]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Timesheet entry not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('EXACT TIMESHEET ENTRY UPDATE ERROR:', err);
    res.status(500).json({ error: 'Error updating timesheet entry' });
  }
});

app.delete('/api/timesheets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM timesheet_entries WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('EXACT TIMESHEET ENTRY DELETE ERROR:', err);
    res.status(500).json({ error: 'Error deleting timesheet entry' });
  }
});

app.get('/api/employees/:id/timesheet', async (req, res) => {
  const { id } = req.params;
  const { start, end } = req.query; // optional date range filter, e.g. ?start=2026-09-01&end=2026-09-30
  try {
    let query = 'SELECT * FROM timesheet_entries WHERE employee_id = $1';
    const params = [id];
    if (start) {
      params.push(start);
      query += ` AND entry_date >= $${params.length}`;
    }
    if (end) {
      params.push(end);
      query += ` AND entry_date <= $${params.length}`;
    }
    query += ' ORDER BY entry_date DESC';

    const result = await pool.query(query, params);
    const entries = result.rows;
    const totalDays = entries.length;
    const totalMinutes = entries.reduce((sum, e) => sum + (e.minutes_worked || 0), 0);
    const avgMinutes = totalDays > 0 ? Math.round(totalMinutes / totalDays) : 0;
    res.json({
      entries,
      stats: { total_days: totalDays, total_minutes: totalMinutes, average_minutes_per_day: avgMinutes }
    });
  } catch (err) {
    console.error('EXACT TIMESHEET FETCH ERROR:', err);
    res.status(500).json({ error: 'Error fetching timesheet' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`RSS Online server is running on port ${PORT}`);
});