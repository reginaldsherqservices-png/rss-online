const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
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

// Get all trainings, filtered by owner (personal list) and with completion status for a given employee
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

// Get all training categories (topics)
app.get('/api/training-categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM training_categories ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT TRAINING CATEGORIES FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching training categories' });
  }
});

// Add a new training category (topic)
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

// Rename a training category (updates all trainings and columns using the old name too)
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

// Delete a training category (and everything inside it)
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

// Add a new training
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

// Update a training's core fields (used for inline row editing)
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

// Delete a training row entirely
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

// Mark a training complete for an employee
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

// Unmark a training as complete
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

// Get custom columns declared for a category
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

// Add a new custom column to a category
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

// Rename a custom column
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

// Remove a custom column
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

// Save a value into a training row's custom column cell
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

// Get an employee's task checklist for a specific training (legacy — kept for compatibility)
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

// Get an employee's progress on a specific training
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

// Update an employee's progress on a specific training (auto-sets completion date at 100%,
// but does NOT mark a Presentation Day Topic complete until the document is uploaded)
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

    // Presentations only count as complete once the document is uploaded — handled in the document upload route instead
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

// Upload a presentation document once marked done — this is what actually marks the presentation complete
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

// Start Server
app.listen(PORT, () => {
  console.log(`RSS Online server is running on port ${PORT}`);
});