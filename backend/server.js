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
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ================= RECYCLE BIN =================
// Whatever is deleted anywhere in the system is first copied into this table (as a snapshot),
// kept for 90 days, and can be restored. After 90 days it is removed for good.
const RECYCLE_DAYS = 90;

const recycleReady = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recycle_bin (
      id SERIAL PRIMARY KEY,
      item_type VARCHAR(50) NOT NULL,
      label TEXT NOT NULL,
      detail TEXT,
      deleted_by TEXT,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      parts JSONB NOT NULL
    )`);
  await recyclePurge();
})().catch(err => console.error('Could not set up the recycle bin:', err));

async function recyclePurge() {
  try {
    const r = await pool.query(`DELETE FROM recycle_bin WHERE deleted_at < NOW() - ($1::text || ' days')::interval`, [String(RECYCLE_DAYS)]);
    if (r.rowCount) console.log(`Recycle bin: permanently removed ${r.rowCount} item(s) older than ${RECYCLE_DAYS} days.`);
  } catch (err) { console.error('RECYCLE PURGE ERROR:', err); }
}
setInterval(recyclePurge, 6 * 60 * 60 * 1000).unref();

// Runs fn inside one database transaction
async function recycleTx(fn) {
  await recycleReady;
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

function recycleWho(req) {
  try { return decodeURIComponent(String(req.headers['x-user-name'] || '')).slice(0, 120) || null; } catch (e) { return null; }
}

// Who may see what in the bin: the admin sees everything; everyone else (managers, interns/employees)
// only sees the items they deleted themselves. Returns an SQL condition and its parameter.
function recycleScope(req, nextParam) {
  const role = String(req.headers['x-user-role'] || '').toLowerCase();
  if (role === 'admin') return { sql: 'TRUE', params: [] };
  return { sql: `deleted_by = $${nextParam}`, params: [recycleWho(req) || '__nobody__'] };
}

// Copies rows into the bin BEFORE they are deleted. `parts` lists the tables to copy, parents first
// (that is the order they are put back in). Returns how many rows the first part found.
// table names come only from code, never from the user.
async function recycleCapture(db, req, type, makeLabel, parts) {
  const saved = [];
  for (const p of parts) {
    const r = await db.query(`SELECT row_to_json(t) AS r FROM ${p.table} t WHERE ${p.where}`, p.params || []);
    saved.push({ table: p.table, rows: r.rows.map(x => x.r) });
  }
  const main = saved[0].rows;
  if (!main.length) return 0;
  const { label, detail } = await makeLabel(main[0], db, main.length);
  await db.query(
    `INSERT INTO recycle_bin (item_type, label, detail, deleted_by, parts) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [type, String(label || 'Item').slice(0, 300), detail ? String(detail).slice(0, 400) : null, recycleWho(req), JSON.stringify(saved.filter(s => s.rows.length))]
  );
  return main.length;
}

const rbName = (a, b) => [a, b].filter(Boolean).join(' ').trim();
async function rbEmployeeName(db, id) {
  if (!id) return '';
  const r = await db.query('SELECT first_name, last_name FROM employees WHERE id = $1', [id]);
  return r.rows.length ? rbName(r.rows[0].first_name, r.rows[0].last_name) : '';
}

app.get('/api/recycle-bin', async (req, res) => {
  try {
    await recycleReady;
    await recyclePurge();
    const scope = recycleScope(req, 2);
    const r = await pool.query(
      `SELECT id, item_type, label, detail, deleted_by, deleted_at,
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (deleted_at + ($1::text || ' days')::interval - NOW())) / 86400))::int AS days_left
       FROM recycle_bin WHERE ${scope.sql} ORDER BY deleted_at DESC`, [String(RECYCLE_DAYS), ...scope.params]);
    res.json(r.rows);
  } catch (err) {
    console.error('RECYCLE LIST ERROR:', err);
    res.status(500).json({ error: 'Error loading the recycle bin' });
  }
});

app.post('/api/recycle-bin/:id/restore', async (req, res) => {
  try {
    const out = await recycleTx(async (db) => {
      const scope = recycleScope(req, 2);
      const r = await db.query(`SELECT * FROM recycle_bin WHERE id = $1 AND ${scope.sql} FOR UPDATE`, [req.params.id, ...scope.params]);
      if (!r.rows.length) return { status: 404, body: { error: 'This item is no longer in the recycle bin.' } };
      const item = r.rows[0];
      for (const part of item.parts) {
        for (const row of part.rows) {
          await db.query(`INSERT INTO ${part.table} SELECT * FROM json_populate_record(NULL::${part.table}, $1::json)`, [JSON.stringify(row)]);
        }
      }
      await db.query('DELETE FROM recycle_bin WHERE id = $1', [item.id]);
      return { status: 200, body: { success: true, item_type: item.item_type, label: item.label } };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error('RECYCLE RESTORE ERROR:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Cannot restore this yet: something with the same name or number already exists now. Rename or remove that one first.' });
    if (err.code === '23503') return res.status(409).json({ error: 'Cannot restore this yet: it belongs to something that was deleted too (for example an employee). Restore that first.' });
    res.status(500).json({ error: 'Error restoring this item' });
  }
});

// Delete several (or all shown) items forever in one go: body { ids: [1, 2, 3] }
app.post('/api/recycle-bin/delete-many', async (req, res) => {
  try {
    await recycleReady;
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
    if (!ids.length) return res.json({ success: true, deleted: 0 });
    const scope = recycleScope(req, 2);
    const r = await pool.query(`DELETE FROM recycle_bin WHERE id = ANY($1::int[]) AND ${scope.sql}`, [ids, ...scope.params]);
    res.json({ success: true, deleted: r.rowCount });
  } catch (err) {
    console.error('RECYCLE DELETE MANY ERROR:', err);
    res.status(500).json({ error: 'Error deleting these items permanently' });
  }
});

app.delete('/api/recycle-bin/:id', async (req, res) => {
  try {
    await recycleReady;
    const scope = recycleScope(req, 2);
    await pool.query(`DELETE FROM recycle_bin WHERE id = $1 AND ${scope.sql}`, [req.params.id, ...scope.params]);
    res.json({ success: true });
  } catch (err) {
    console.error('RECYCLE DELETE FOREVER ERROR:', err);
    res.status(500).json({ error: 'Error deleting this item permanently' });
  }
});

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

      // Save a copy of the employee and everything tied to them in the recycle bin first (parents first)
      const rbParts = [{ table: 'employees', where: 'id = $1', params: [id] }];
      if (hasColumn('users', 'employee_id')) rbParts.push({ table: 'users', where: 'employee_id = $1', params: [id] });
      if (hasColumn('report_templates', 'employee_id')) rbParts.push({ table: 'report_templates', where: 'employee_id = $1', params: [id] });
      if (hasColumn('overtime_entries', 'employee_id')) {
        rbParts.push({ table: 'overtime_entries', where: 'employee_id = $1', params: [id] });
        rbParts.push({ table: 'overtime_takings', where: 'overtime_entry_id IN (SELECT id FROM overtime_entries WHERE employee_id = $1)', params: [id] });
      }
      for (const t of ['leave_requests', 'leave_table_customizations', 'report_submissions', 'monthly_reports', 'training_completions', 'training_progress', 'timesheet_entries']) {
        if (hasColumn(t, 'employee_id')) rbParts.push({ table: t, where: 'employee_id = $1', params: [id] });
      }
      await recycleReady;
      await recycleCapture(client, req, 'employee', (e) => ({ label: rbName(e.first_name, e.last_name) || 'Employee', detail: [e.job_title, e.department, 'with all their records'].filter(Boolean).join(' · ') }), rbParts);

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
      if (hasColumn('report_submissions', 'employee_id')) {
        await client.query('DELETE FROM report_submissions WHERE employee_id = $1', [id]);
      }
      if (hasColumn('monthly_reports', 'employee_id')) {
        await client.query('DELETE FROM monthly_reports WHERE employee_id = $1', [id]);
      }
      if (hasColumn('report_templates', 'employee_id')) {
        await client.query('DELETE FROM report_templates WHERE employee_id = $1', [id]);
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
    const result = await recycleTx(async (db) => {
      await recycleCapture(db, req, 'employee', (e) => ({ label: rbName(e.first_name, e.last_name) || 'Employee', detail: [e.job_title, e.department].filter(Boolean).join(' · ') }),
        [{ table: 'employees', where: 'id = $1', params: [id] }]);
      return db.query('DELETE FROM employees WHERE id = $1 RETURNING *', [id]);
    });
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

    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'training_topic', async (c, d, n) => {
        const t = await d.query('SELECT COUNT(*)::int AS n FROM trainings WHERE category = $1', [name]);
        return { label: c.name, detail: `Training topic with ${t.rows[0].n} training${t.rows[0].n === 1 ? '' : 's'}` };
      }, [
        { table: 'training_categories', where: 'id = $1', params: [id] },
        { table: 'training_category_columns', where: 'category = $1', params: [name] },
        { table: 'trainings', where: 'category = $1', params: [name] },
        { table: 'training_completions', where: 'training_id IN (SELECT id FROM trainings WHERE category = $1)', params: [name] }
      ]);
      await db.query('DELETE FROM training_category_columns WHERE category = $1', [name]);
      await db.query('DELETE FROM trainings WHERE category = $1', [name]);
      await db.query('DELETE FROM training_categories WHERE id = $1', [id]);
    });

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
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'training', (t) => ({ label: t.title || 'Training', detail: [t.category, t.training_date ? String(t.training_date).slice(0, 10) : ''].filter(Boolean).join(' · ') }), [
        { table: 'trainings', where: 'id = $1', params: [id] },
        { table: 'training_completions', where: 'training_id = $1', params: [id] }
      ]);
      await db.query('DELETE FROM trainings WHERE id = $1', [id]);
    });
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
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'training_column', (c) => ({ label: c.column_name || 'Column', detail: c.category ? `Column in ${c.category}` : null }),
        [{ table: 'training_category_columns', where: 'id = $1', params: [id] }]);
      await db.query('DELETE FROM training_category_columns WHERE id = $1', [id]);
    });
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
    res.status(500).json({ error: 'Error saving weekly tasks', detail: err.message });
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
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'overtime', async (o, d) => ({
        label: `Overtime: ${(await rbEmployeeName(d, o.employee_id)) || 'employee'}`,
        detail: `${o.minutes_worked} minutes worked on ${String(o.date_worked).slice(0, 10)}`
      }), [
        { table: 'overtime_entries', where: 'id = $1', params: [entryId] },
        { table: 'overtime_takings', where: 'overtime_entry_id = $1', params: [entryId] }
      ]);
      await db.query('DELETE FROM overtime_takings WHERE overtime_entry_id = $1', [entryId]);
      await db.query('DELETE FROM overtime_entries WHERE id = $1', [entryId]);
    });
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
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'overtime_taking', async (t, d) => {
        const e = await d.query('SELECT employee_id FROM overtime_entries WHERE id = $1', [t.overtime_entry_id]);
        return { label: `Overtime taken: ${(await rbEmployeeName(d, e.rows[0] && e.rows[0].employee_id)) || 'employee'}`, detail: `${t.minutes_taken} minutes on ${String(t.date_taken).slice(0, 10)}${t.note ? ' · ' + t.note : ''}` };
      }, [{ table: 'overtime_takings', where: 'id = $1', params: [takingId] }]);
      await db.query('DELETE FROM overtime_takings WHERE id = $1', [takingId]);
    });
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
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'rss_training_type', (t) => ({ label: t.name || 'Training type', detail: [t.prefix, t.unit_standard].filter(Boolean).join(' · ') }),
        [{ table: 'rss_training_types', where: 'id = $1', params: [id] }]);
      await db.query('DELETE FROM rss_training_types WHERE id = $1', [id]);
    });
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

    // Ascending by certificate number: year first, then the running number at the end
    // (so ...2025/029 comes before ...2025/030 whatever the prefix). Records without a number go last.
    query += String.raw` ORDER BY
      NULLIF(substring(certificate_number from '(\d{4})/\d+\s*$'), '')::int ASC NULLS LAST,
      NULLIF(substring(certificate_number from '/(\d+)\s*$'), '')::int ASC NULLS LAST,
      date_of_training ASC NULLS LAST, id ASC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT RSS LEARNERS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching learners' });
  }
});

// ---- Certificate numbers: PREFIX + YEAR + / + 3-digit counter (e.g. CBFF2025/023) ----
// The prefix depends on the type of training, but the counter is ONE running count for the
// whole year across all trainings. The next number continues after the highest number already
// used in that year, so numbers typed by hand (to match older records) are respected.
async function nextCertificateNumber(trainingType, year, db) {
  db = db || pool;
  const typeResult = await db.query('SELECT prefix FROM rss_training_types WHERE name = $1', [trainingType]);
  const prefix = (typeResult.rows[0] && typeResult.rows[0].prefix) || String(trainingType || '').substring(0, 2).toUpperCase();
  const used = await db.query(
    'SELECT certificate_number FROM rss_training_learners WHERE certificate_number IS NOT NULL AND certificate_number LIKE $1',
    [`%${year}/%`]
  );
  let maxSeq = 0;
  used.rows.forEach(r => {
    const m = /(\d{4})\/(\d+)\s*$/.exec(String(r.certificate_number));
    if (m && parseInt(m[1], 10) === year) {
      const n = parseInt(m[2], 10);
      if (n > maxSeq) maxSeq = n;
    }
  });
  const seq = maxSeq + 1;
  return { prefix, seq, number: `${prefix}${year}/${String(seq).padStart(3, '0')}` };
}

// Keeps the counter at or above the highest number saved, so the next automatic one never repeats it.
async function bumpCertificateCounter(trainingType, year, certificateNumber, db) {
  db = db || pool;
  const n = parseInt(String(certificateNumber).split('/').pop(), 10);
  if (isNaN(n)) return;
  // If the number was typed by hand, count it under the year written in the number itself.
  const yearInNumber = /(\d{4})\/\d+$/.exec(String(certificateNumber));
  if (yearInNumber) year = parseInt(yearInNumber[1], 10);
  await db.query(
    `INSERT INTO rss_certificate_counters (training_type, year, last_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (training_type, year) DO UPDATE SET last_number = GREATEST(rss_certificate_counters.last_number, $3)`,
    [trainingType, year, n]
  );
}

function certYearFrom(dateOfTraining) {
  const m = /^(\d{4})/.exec(String(dateOfTraining || ''));
  return m ? parseInt(m[1], 10) : new Date().getFullYear();
}

// Suggests the next certificate number (shown in the form when the date is chosen). Nothing is saved.
app.get('/api/rss-learners/next-certificate-number', async (req, res) => {
  const { training_type, date_of_training } = req.query;
  if (!training_type) return res.status(400).json({ error: 'training_type is required' });
  try {
    const next = await nextCertificateNumber(training_type, certYearFrom(date_of_training));
    res.json({ certificate_number: next.number });
  } catch (err) {
    console.error("EXACT NEXT CERTIFICATE NUMBER ERROR:", err);
    res.status(500).json({ error: 'Error working out the next certificate number' });
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
  const typedCertNumber = String(req.body.certificate_number || '').trim();

  if (!first_name || !last_name || !training_type) {
    return res.status(400).json({ error: 'First name, last name, and training type are required' });
  }

  const hasPassed = passed === 'true';

  try {
    let certificate_number = null;
    let typeRow = {};

    const typeResult = await pool.query('SELECT prefix, unit_standard, nqf_level, credits FROM rss_training_types WHERE name = $1', [training_type]);
    typeRow = typeResult.rows[0] || {};

    // A passed result gets a certificate number: the one typed in the form, or the next automatic one.
    if (hasPassed) {
      const year = certYearFrom(date_of_training);
      if (typedCertNumber) {
        const dup = await pool.query('SELECT id FROM rss_training_learners WHERE certificate_number = $1', [typedCertNumber]);
        if (dup.rows.length) return res.status(409).json({ error: `Certificate number ${typedCertNumber} is already used by another learner.` });
        certificate_number = typedCertNumber;
      } else {
        certificate_number = (await nextCertificateNumber(training_type, year)).number;
      }
      await bumpCertificateCounter(training_type, year, certificate_number);
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
  const typedCertNumber = String(req.body.certificate_number || '').trim();
  const hasPassed = passed === true || passed === 'true';
  try {
    if (!hasPassed) {
      await pool.query('UPDATE rss_training_learners SET certificate_number = NULL WHERE id = $1', [id]);
    } else {
      const current = await pool.query('SELECT certificate_number FROM rss_training_learners WHERE id = $1', [id]);
      const existing = current.rows[0] ? current.rows[0].certificate_number : null;
      let newNumber = typedCertNumber || existing;
      if (typedCertNumber && typedCertNumber !== existing) {
        const dup = await pool.query('SELECT id FROM rss_training_learners WHERE certificate_number = $1 AND id <> $2', [typedCertNumber, id]);
        if (dup.rows.length) return res.status(409).json({ error: `Certificate number ${typedCertNumber} is already used by another learner.` });
      }
      const year = certYearFrom(date_of_training);
      if (!newNumber) newNumber = (await nextCertificateNumber(training_type, year)).number;
      await pool.query('UPDATE rss_training_learners SET certificate_number = $2 WHERE id = $1', [id, newNumber]);
      await bumpCertificateCounter(training_type, year, newNumber);
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
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'rss_learner', (l) => ({ label: rbName(l.first_name, l.last_name) || 'Learner', detail: [l.training_type, l.client, l.certificate_number].filter(Boolean).join(' · ') }),
        [{ table: 'rss_training_learners', where: 'id = $1', params: [id] }]);
      await db.query('DELETE FROM rss_training_learners WHERE id = $1', [id]);
    });
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
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'rss_manual', (m) => ({ label: m.file_name || 'Manual', detail: m.training_type || null }),
        [{ table: 'rss_training_manuals', where: 'id = $1', params: [id] }]);
      await db.query('DELETE FROM rss_training_manuals WHERE id = $1', [id]);
    });
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
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'timesheet_entry', async (t, d) => ({
        label: `Timesheet: ${(await rbEmployeeName(d, t.employee_id)) || 'employee'}`,
        detail: `${String(t.entry_date).slice(0, 10)}${t.time_in ? ' · in ' + String(t.time_in).slice(0, 5) : ''}${t.time_out ? ' · out ' + String(t.time_out).slice(0, 5) : ''}`
      }), [{ table: 'timesheet_entries', where: 'id = $1', params: [id] }]);
      await db.query('DELETE FROM timesheet_entries WHERE id = $1', [id]);
    });
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

// ============ REPORTS (checklist templates + submitted reports) ============
//
// A template is a named checklist made of headings, each with a list of
// questions:  structure = [{ title: 'First Aid Boxes', questions: ['Ensure ...', ...] }, ...]
// A submission is one filled-in report. It stores a snapshot of the heading /
// question text next to each answer, so editing a template later never
// changes reports that were already submitted.
//
// The tables are created automatically on startup (CREATE TABLE IF NOT EXISTS),
// so nothing has to be run by hand on the local or the Azure database.
async function ensureReportTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_templates (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      structure JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // A template can belong to one employee (their own job description headings).
  // NULL means a general template anyone can use. Added with ALTER so databases
  // that already created the table in the earlier version are upgraded too.
  await pool.query('ALTER TABLE report_templates ADD COLUMN IF NOT EXISTS employee_id INTEGER');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_submissions (
      id SERIAL PRIMARY KEY,
      template_id INTEGER,
      template_name VARCHAR(200),
      employee_id INTEGER,
      employee_name VARCHAR(200),
      report_date DATE NOT NULL,
      answers JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE report_submissions ADD COLUMN IF NOT EXISTS client_name VARCHAR(200) DEFAULT ''");
  // Saved monthly reports ("Monthly Reports" folder). Keeps a copy of the weekly
  // reports it was built from, so it stays complete even if a weekly one is deleted later.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monthly_reports (
      id SERIAL PRIMARY KEY,
      month VARCHAR(7) NOT NULL,
      employee_id INTEGER,
      employee_name VARCHAR(200),
      client_name VARCHAR(200) DEFAULT '',
      checklist_name VARCHAR(200) DEFAULT '',
      period_start VARCHAR(10),
      period_end VARCHAR(10),
      weeks INTEGER DEFAULT 0,
      reports JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Keeps only well-formed headings/questions and trims blanks.
function cleanReportStructure(structure) {
  if (!Array.isArray(structure)) return [];
  return structure
    .map(h => ({
      title: String((h && h.title) || '').trim(),
      questions: Array.isArray(h && h.questions)
        ? h.questions.map(q => String(q || '').trim()).filter(q => q.length > 0)
        : []
    }))
    .filter(h => h.title.length > 0);
}

app.get('/api/report-templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM report_templates ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT REPORT TEMPLATES FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching report templates' });
  }
});

app.post('/api/report-templates', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Template name is required' });
  try {
    const result = await pool.query(
      'INSERT INTO report_templates (name, structure, employee_id) VALUES ($1, $2::jsonb, $3) RETURNING *',
      [name, JSON.stringify(cleanReportStructure(req.body.structure)), req.body.employee_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT REPORT TEMPLATE CREATE ERROR:", err);
    res.status(500).json({ error: 'Error creating report template', detail: err.message });
  }
});

app.put('/api/report-templates/:id', async (req, res) => {
  const { id } = req.params;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Template name is required' });
  try {
    const result = await pool.query(
      `UPDATE report_templates
       SET name = $2, structure = $3::jsonb, employee_id = $4, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, name, JSON.stringify(cleanReportStructure(req.body.structure)), req.body.employee_id || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("EXACT REPORT TEMPLATE UPDATE ERROR:", err);
    res.status(500).json({ error: 'Error updating report template', detail: err.message });
  }
});

// Deleting a template does not touch reports already submitted from it.
app.delete('/api/report-templates/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'report_template', (t) => ({ label: t.name || 'Checklist', detail: 'Report checklist' }),
        [{ table: 'report_templates', where: 'id = $1', params: [id] }]);
      await db.query('DELETE FROM report_templates WHERE id = $1', [id]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT REPORT TEMPLATE DELETE ERROR:", err);
    res.status(500).json({ error: 'Error deleting report template' });
  }
});

app.get('/api/report-submissions', async (req, res) => {
  const { employee_id, template_id } = req.query;
  try {
    const params = [];
    const where = [];
    if (employee_id) { params.push(employee_id); where.push(`employee_id = $${params.length}`); }
    if (template_id) { params.push(template_id); where.push(`template_id = $${params.length}`); }
    // report_date is returned as plain 'YYYY-MM-DD' text so time zones can
    // never shift it to the previous/next day.
    const sql = `SELECT id, template_id, template_name, employee_id, employee_name,
                        to_char(report_date, 'YYYY-MM-DD') AS report_date, client_name, answers, created_at
                 FROM report_submissions
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY report_date DESC, id DESC`;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT REPORT SUBMISSIONS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching reports' });
  }
});

app.post('/api/report-submissions', async (req, res) => {
  const { template_id, template_name, employee_id, employee_name, client_name, report_date, answers } = req.body;
  if (!employee_id || !report_date || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'employee_id, report_date and answers are required' });
  }
  try {
    const cleanAnswers = answers.map(a => ({
      heading: String(a.heading || ''),
      question: String(a.question || ''),
      answer: a.answer === 'yes' || a.answer === 'no' ? a.answer : null,
      comment: String(a.comment || '')
    }));
    const result = await pool.query(
      `INSERT INTO report_submissions
         (template_id, template_name, employee_id, employee_name, client_name, report_date, answers)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
      [template_id || null, template_name || '', employee_id, employee_name || '', String(client_name || '').trim().slice(0, 200), report_date, JSON.stringify(cleanAnswers)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT REPORT SUBMISSION CREATE ERROR:", err);
    res.status(500).json({ error: 'Error saving report', detail: err.message });
  }
});

app.delete('/api/report-submissions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'report_submission', (r) => ({ label: `${r.template_name || 'Weekly report'} · ${r.employee_name || ''}`.trim(), detail: [r.client_name, r.report_date ? String(r.report_date).slice(0, 10) : ''].filter(Boolean).join(' · ') }),
        [{ table: 'report_submissions', where: 'id = $1', params: [id] }]);
      await db.query('DELETE FROM report_submissions WHERE id = $1', [id]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT REPORT SUBMISSION DELETE ERROR:", err);
    res.status(500).json({ error: 'Error deleting report' });
  }
});

app.get('/api/monthly-reports', async (req, res) => {
  const { employee_id } = req.query;
  try {
    const params = [];
    let where = '';
    if (employee_id) { params.push(employee_id); where = 'WHERE employee_id = $1'; }
    const result = await pool.query(`SELECT * FROM monthly_reports ${where} ORDER BY month DESC, client_name, id DESC`, params);
    res.json(result.rows);
  } catch (err) {
    console.error("EXACT MONTHLY REPORTS FETCH ERROR:", err);
    res.status(500).json({ error: 'Error fetching monthly reports' });
  }
});

// One monthly report per person + client + month: generating it again replaces the earlier copy.
app.post('/api/monthly-reports', async (req, res) => {
  const { month, employee_id, employee_name, client_name, checklist_name, period_start, period_end, reports } = req.body;
  if (!/^\d{4}-\d{2}$/.test(String(month || '')) || !Array.isArray(reports) || reports.length === 0) {
    return res.status(400).json({ error: 'month (YYYY-MM) and reports are required' });
  }
  const client = pool;
  try {
    await client.query('DELETE FROM monthly_reports WHERE month = $1 AND COALESCE(employee_id, 0) = COALESCE($2::int, 0) AND COALESCE(client_name, \'\') = $3',
      [month, employee_id || null, String(client_name || '')]);
    const result = await client.query(
      `INSERT INTO monthly_reports (month, employee_id, employee_name, client_name, checklist_name, period_start, period_end, weeks, reports)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING *`,
      [month, employee_id || null, employee_name || '', String(client_name || ''), checklist_name || '', period_start || null, period_end || null, reports.length, JSON.stringify(reports)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("EXACT MONTHLY REPORT CREATE ERROR:", err);
    res.status(500).json({ error: 'Error saving monthly report', detail: err.message });
  }
});

app.delete('/api/monthly-reports/:id', async (req, res) => {
  try {
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'monthly_report', (m) => ({ label: `Monthly report ${m.month || ''} · ${m.employee_name || ''}`.trim(), detail: [m.client_name, m.checklist_name].filter(Boolean).join(' · ') }),
        [{ table: 'monthly_reports', where: 'id = $1', params: [req.params.id] }]);
      await db.query('DELETE FROM monthly_reports WHERE id = $1', [req.params.id]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error("EXACT MONTHLY REPORT DELETE ERROR:", err);
    res.status(500).json({ error: 'Error deleting monthly report' });
  }
});

ensureReportTables().catch(err => console.error('Could not create report tables:', err));

// ================= FINANCE: INVOICES & QUOTES =================
async function ensureFinanceTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_settings (
      key VARCHAR(50) PRIMARY KEY,
      value TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_clients (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL UNIQUE,
      code VARCHAR(10),
      invoice_last INTEGER DEFAULT 100,
      quote_last INTEGER DEFAULT 100,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_documents (
      id SERIAL PRIMARY KEY,
      doc_type VARCHAR(10) NOT NULL,
      client_name VARCHAR(200) NOT NULL,
      doc_number VARCHAR(80) NOT NULL,
      doc_date DATE,
      reference TEXT,
      deliver_to TEXT,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      vat_text VARCHAR(50),
      bank_details TEXT,
      subtotal NUMERIC(14,2) DEFAULT 0,
      total NUMERIC(14,2) DEFAULT 0,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (doc_type, doc_number)
    )`);
  // Payment tracking (which lines were paid is kept on each line as "paid": true)
  await pool.query(`ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS payment_status VARCHAR(10) DEFAULT 'unpaid'`);
  await pool.query(`ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14,2) DEFAULT 0`);
  await pool.query(`ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS paid_date DATE`);
  await pool.query(`ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS payment_note TEXT`);
  await pool.query(`ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS statement_issued_at TIMESTAMP`);
  // Client details printed on the client statement
  await pool.query(`ALTER TABLE finance_clients ADD COLUMN IF NOT EXISTS address TEXT`);
  await pool.query(`ALTER TABLE finance_clients ADD COLUMN IF NOT EXISTS vat_number VARCHAR(50)`);
  await pool.query(`ALTER TABLE finance_clients ADD COLUMN IF NOT EXISTS phone VARCHAR(50)`);
  await pool.query(`ALTER TABLE finance_clients ADD COLUMN IF NOT EXISTS email VARCHAR(150)`);
  await pool.query(`ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS expiry_date DATE`);
  // Client statements that were created (a saved copy of exactly what was on the statement)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_statements (
      id SERIAL PRIMARY KEY,
      client_name VARCHAR(200) NOT NULL,
      date_from DATE,
      date_to DATE,
      statement_date DATE,
      unpaid_only BOOLEAN DEFAULT FALSE,
      invoice_count INTEGER DEFAULT 0,
      invoiced NUMERIC(14,2) DEFAULT 0,
      paid NUMERIC(14,2) DEFAULT 0,
      balance NUMERIC(14,2) DEFAULT 0,
      data JSONB NOT NULL,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
}

function financeClientCode(name) {
  const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return 'XX';
  if (words.length === 1) return words[0].substring(0, 2);
  return words.slice(0, 3).map(w => w[0]).join('');
}

// INV-RP101-2026: the client's letters + a running number for THAT client + the year.
// Next number = the higher of "last number used" typed in for the client and the highest already saved, plus one.
async function nextFinanceNumber(docType, clientName, year) {
  const label = docType === 'quote' ? 'QUO' : 'INV';
  const name = String(clientName || '').trim();
  const c = await pool.query('SELECT code, invoice_last, quote_last FROM finance_clients WHERE LOWER(name) = LOWER($1)', [name]);
  const rec = c.rows[0] || {};
  const code = (rec.code || financeClientCode(name)).toUpperCase();
  // Every new year starts again at 101 for each client (INV-CL101-2027, INV-CL101-2028 ...).
  // The "last number already used" typed on the client only counts for the current year.
  let max = 100;
  if (year === new Date().getFullYear()) {
    const typed = parseInt(docType === 'quote' ? rec.quote_last : rec.invoice_last, 10);
    if (!isNaN(typed)) max = typed;
  }
  const rows = await pool.query('SELECT doc_number FROM finance_documents WHERE doc_type = $1 AND LOWER(client_name) = LOWER($2)', [docType, name]);
  const re = /(\d+)-(\d{4})\s*$/;
  rows.rows.forEach(r => { const m = re.exec(r.doc_number); if (m && parseInt(m[2], 10) === year) max = Math.max(max, parseInt(m[1], 10)); });
  return `${label}-${code}${max + 1}-${year}`;
}

function financeNumber(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function financeTotals(items, vatText) {
  const subtotal = (Array.isArray(items) ? items : []).reduce((s, it) => s + financeNumber(it.quantity) * financeNumber(it.unit_price), 0);
  const vat = /\d/.test(String(vatText || '')) ? financeNumber(vatText) : 0;
  return { subtotal: Math.round(subtotal * 100) / 100, total: Math.round((subtotal + vat) * 100) / 100 };
}

// Works out Unpaid / Partly paid / Paid from the lines that are ticked as paid.
// VAT is shared out in the same proportion as the lines that were paid.
function financePaymentSummary(items, vatText) {
  const arr = Array.isArray(items) ? items : [];
  const t = financeTotals(arr, vatText);
  const lineAmount = it => financeNumber(it.quantity) * financeNumber(it.unit_price);
  const paidLines = arr.filter(it => it && it.paid);
  const paidSub = paidLines.reduce((s, it) => s + lineAmount(it), 0);
  let status = 'unpaid';
  if (arr.length && paidLines.length === arr.length) status = 'paid';
  else if (paidLines.length) status = 'partial';
  let paid = 0;
  if (status === 'paid') paid = t.total;
  else if (t.subtotal > 0) paid = paidSub + (t.total - t.subtotal) * (paidSub / t.subtotal);
  return { status, paid_amount: Math.round(paid * 100) / 100 };
}
const FINANCE_DOC_COLS = `id, doc_type, client_name, doc_number, to_char(doc_date,'YYYY-MM-DD') AS doc_date, reference, deliver_to, items, vat_text, bank_details, subtotal, total,
  COALESCE(payment_status, 'unpaid') AS payment_status, COALESCE(paid_amount, 0) AS paid_amount, to_char(paid_date,'YYYY-MM-DD') AS paid_date, payment_note, statement_issued_at, to_char(expiry_date,'YYYY-MM-DD') AS expiry_date`;

app.get('/api/finance/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM finance_settings');
    const out = {};
    result.rows.forEach(r => { out[r.key] = r.value; });
    res.json(out);
  } catch (err) {
    console.error('FINANCE SETTINGS FETCH ERROR:', err);
    res.status(500).json({ error: 'Error fetching finance settings' });
  }
});

app.put('/api/finance/settings', async (req, res) => {
  try {
    for (const key of ['logo', 'bank_details']) {
      if (req.body[key] !== undefined) {
        await pool.query(
          `INSERT INTO finance_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, req.body[key]]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('FINANCE SETTINGS SAVE ERROR:', err);
    res.status(500).json({ error: 'Error saving finance settings' });
  }
});

app.get('/api/finance/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, code, invoice_last, quote_last, address, vat_number, phone, email FROM finance_clients ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('FINANCE CLIENTS FETCH ERROR:', err);
    res.status(500).json({ error: 'Error fetching clients' });
  }
});

// Add a client, or update one if the name already exists (letters and "last number used").
app.post('/api/finance/clients', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const code = (String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || financeClientCode(name)).substring(0, 10);
  const num = v => { const n = parseInt(v, 10); return isNaN(n) || n < 0 ? 100 : n; };
  try {
    // Contact details are only changed when they are sent (so saving the numbers alone never wipes them)
    const txt = (v, max) => (v === undefined || v === null) ? null : String(v).trim().slice(0, max);
    const result = await pool.query(
      `INSERT INTO finance_clients (name, code, invoice_last, quote_last, address, vat_number, phone, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (name) DO UPDATE SET code = EXCLUDED.code, invoice_last = EXCLUDED.invoice_last, quote_last = EXCLUDED.quote_last,
         address = COALESCE($5, finance_clients.address), vat_number = COALESCE($6, finance_clients.vat_number),
         phone = COALESCE($7, finance_clients.phone), email = COALESCE($8, finance_clients.email)
       RETURNING id, name, code, invoice_last, quote_last, address, vat_number, phone, email`,
      [name, code, num(req.body.invoice_last), num(req.body.quote_last), txt(req.body.address, 500), txt(req.body.vat_number, 50), txt(req.body.phone, 50), txt(req.body.email, 150)]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('FINANCE CLIENT SAVE ERROR:', err);
    res.status(500).json({ error: 'Error saving client' });
  }
});

app.delete('/api/finance/clients/:id', async (req, res) => {
  try {
    const c = await pool.query('SELECT name FROM finance_clients WHERE id = $1', [req.params.id]);
    if (!c.rows.length) return res.json({ success: true });
    const used = await pool.query('SELECT 1 FROM finance_documents WHERE LOWER(client_name) = LOWER($1) LIMIT 1', [c.rows[0].name]);
    if (used.rows.length) return res.status(409).json({ error: 'This client already has invoices or quotes, so it cannot be removed.' });
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'finance_client', (f) => ({ label: f.name, detail: 'Finance client' }),
        [{ table: 'finance_clients', where: 'id = $1', params: [req.params.id] }]);
      await db.query('DELETE FROM finance_clients WHERE id = $1', [req.params.id]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error('FINANCE CLIENT DELETE ERROR:', err);
    res.status(500).json({ error: 'Error removing client' });
  }
});

app.get('/api/finance/next-number', async (req, res) => {
  const docType = req.query.doc_type === 'quote' ? 'quote' : 'invoice';
  const year = parseInt(String(req.query.date || '').substring(0, 4), 10) || new Date().getFullYear();
  try {
    res.json({ doc_number: await nextFinanceNumber(docType, req.query.client_name, year) });
  } catch (err) {
    console.error('FINANCE NEXT NUMBER ERROR:', err);
    res.status(500).json({ error: 'Error generating number' });
  }
});

app.get('/api/finance-documents', async (req, res) => {
  const docType = req.query.doc_type === 'quote' ? 'quote' : 'invoice';
  try {
    const result = await pool.query(
      `SELECT ${FINANCE_DOC_COLS}, created_at
       FROM finance_documents WHERE doc_type = $1 ORDER BY doc_date DESC NULLS LAST, id DESC`, [docType]);
    res.json(result.rows);
  } catch (err) {
    console.error('FINANCE DOCUMENTS FETCH ERROR:', err);
    res.status(500).json({ error: 'Error fetching documents' });
  }
});

app.post('/api/finance-documents', async (req, res) => {
  const b = req.body;
  const docType = b.doc_type === 'quote' ? 'quote' : 'invoice';
  const client = String(b.client_name || '').trim();
  if (!client) return res.status(400).json({ error: 'Please choose or type the client' });
  const year = parseInt(String(b.doc_date || '').substring(0, 4), 10) || new Date().getFullYear();
  try {
    let docNumber = String(b.doc_number || '').trim();
    if (b.auto_number || !docNumber) docNumber = await nextFinanceNumber(docType, client, year);
    const dup = await pool.query('SELECT id FROM finance_documents WHERE doc_type = $1 AND doc_number = $2', [docType, docNumber]);
    if (dup.rows.length) return res.status(409).json({ error: `Number ${docNumber} is already used.` });
    const t = financeTotals(b.items, b.vat_text);
    await pool.query('INSERT INTO finance_clients (name, code) SELECT $1::varchar, $2::varchar WHERE NOT EXISTS (SELECT 1 FROM finance_clients WHERE LOWER(name) = LOWER($1::varchar))', [client, financeClientCode(client)]);
    const pay = financePaymentSummary(b.items, b.vat_text);
    const result = await pool.query(
      `INSERT INTO finance_documents (doc_type, client_name, doc_number, doc_date, reference, deliver_to, items, vat_text, bank_details, subtotal, total, created_by, payment_status, paid_amount, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING ${FINANCE_DOC_COLS}`,
      [docType, client, docNumber, b.doc_date || null, b.reference || null, b.deliver_to || null, JSON.stringify(b.items || []),
       b.vat_text || null, b.bank_details || null, t.subtotal, t.total, b.created_by || null, pay.status, pay.paid_amount, b.expiry_date || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('FINANCE DOCUMENT CREATE ERROR:', err);
    res.status(500).json({ error: 'Error saving document' });
  }
});

app.put('/api/finance-documents/:id', async (req, res) => {
  const b = req.body;
  const client = String(b.client_name || '').trim();
  const docNumber = String(b.doc_number || '').trim();
  if (!client || !docNumber) return res.status(400).json({ error: 'Client and document number are required' });
  try {
    const current = await pool.query('SELECT doc_type FROM finance_documents WHERE id = $1', [req.params.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Not found' });
    const docType = current.rows[0].doc_type;
    const dup = await pool.query('SELECT id FROM finance_documents WHERE doc_type = $1 AND doc_number = $2 AND id <> $3', [docType, docNumber, req.params.id]);
    if (dup.rows.length) return res.status(409).json({ error: `Number ${docNumber} is already used.` });
    const t = financeTotals(b.items, b.vat_text);
    await pool.query('INSERT INTO finance_clients (name, code) SELECT $1::varchar, $2::varchar WHERE NOT EXISTS (SELECT 1 FROM finance_clients WHERE LOWER(name) = LOWER($1::varchar))', [client, financeClientCode(client)]);
    const pay = financePaymentSummary(b.items, b.vat_text);
    const result = await pool.query(
      `UPDATE finance_documents SET client_name=$2, doc_number=$3, doc_date=$4, reference=$5, deliver_to=$6, items=$7, vat_text=$8, bank_details=$9, subtotal=$10, total=$11, payment_status=$12, paid_amount=$13, expiry_date=$14, updated_at=NOW()
       WHERE id=$1
       RETURNING ${FINANCE_DOC_COLS}`,
      [req.params.id, client, docNumber, b.doc_date || null, b.reference || null, b.deliver_to || null, JSON.stringify(b.items || []),
       b.vat_text || null, b.bank_details || null, t.subtotal, t.total, pay.status, pay.paid_amount, b.expiry_date || null]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('FINANCE DOCUMENT UPDATE ERROR:', err);
    res.status(500).json({ error: 'Error saving document' });
  }
});

// Record which lines have been paid, each with the date it was paid
// body: { paid_lines: [ { index: 0, date: '2026-10-24' }, { index: 2, date: '2026-10-29' } ], payment_note }
app.put('/api/finance-documents/:id/payment', async (req, res) => {
  try {
    const cur = await pool.query(`SELECT items, vat_text, to_char(paid_date,'YYYY-MM-DD') AS paid_date FROM finance_documents WHERE id = $1`, [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const today = new Date().toISOString().slice(0, 10);
    const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const paidMap = new Map();
    (Array.isArray(req.body.paid_lines) ? req.body.paid_lines : []).forEach(l => {
      const obj = l !== null && typeof l === 'object';
      const idx = parseInt(obj ? l.index : l, 10);
      if (!isNaN(idx)) paidMap.set(idx, obj && isDay(l.date) ? l.date : (isDay(req.body.paid_date) ? req.body.paid_date : null));
    });
    const items = (cur.rows[0].items || []).map((it, i) => {
      const copy = { ...it };
      if (paidMap.has(i)) {
        copy.paid = true;
        // keep the date a line was already paid on unless a new one was given
        copy.paid_date = paidMap.get(i) || copy.paid_date || cur.rows[0].paid_date || today;
      } else {
        delete copy.paid;
        delete copy.paid_date;
      }
      return copy;
    });
    const pay = financePaymentSummary(items, cur.rows[0].vat_text);
    const dates = items.filter(it => it.paid && it.paid_date).map(it => it.paid_date).sort();
    const paidDate = pay.status === 'unpaid' ? null : (dates.length ? dates[dates.length - 1] : today);   // the latest payment
    const result = await pool.query(
      `UPDATE finance_documents SET items=$2, payment_status=$3, paid_amount=$4, paid_date=$5, payment_note=$6, updated_at=NOW()
       WHERE id=$1 RETURNING ${FINANCE_DOC_COLS}`,
      [req.params.id, JSON.stringify(items), pay.status, pay.paid_amount, paidDate, String(req.body.payment_note || '').trim().slice(0, 500) || null]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('FINANCE PAYMENT SAVE ERROR:', err);
    res.status(500).json({ error: 'Error saving the payment' });
  }
});

// Remember that a statement was issued for this invoice
app.post('/api/finance-documents/:id/statement-issued', async (req, res) => {
  try {
    const result = await pool.query(`UPDATE finance_documents SET statement_issued_at = NOW() WHERE id = $1 RETURNING ${FINANCE_DOC_COLS}`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('FINANCE STATEMENT ISSUED ERROR:', err);
    res.status(500).json({ error: 'Error saving' });
  }
});

app.delete('/api/finance-documents/:id', async (req, res) => {
  try {
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'finance_document', (f) => ({ label: f.doc_number, detail: `${f.doc_type === 'quote' ? 'Quote' : 'Invoice'} · ${f.client_name || ''} · R ${Number(f.total || 0).toFixed(2)}` }),
        [{ table: 'finance_documents', where: 'id = $1', params: [req.params.id] }]);
      await db.query('DELETE FROM finance_documents WHERE id = $1', [req.params.id]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error('FINANCE DOCUMENT DELETE ERROR:', err);
    res.status(500).json({ error: 'Error deleting document' });
  }
});

// ---- Saved client statements ----
const FIN_STMT_LIST_COLS = `id, client_name, to_char(date_from,'YYYY-MM-DD') AS date_from, to_char(date_to,'YYYY-MM-DD') AS date_to,
  to_char(statement_date,'YYYY-MM-DD') AS statement_date, unpaid_only, invoice_count, invoiced, paid, balance, created_by, created_at`;

app.get('/api/finance-statements', async (req, res) => {
  try {
    const result = await pool.query(`SELECT ${FIN_STMT_LIST_COLS} FROM finance_statements ORDER BY created_at DESC, id DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('FINANCE STATEMENTS FETCH ERROR:', err);
    res.status(500).json({ error: 'Error fetching statements' });
  }
});

app.get('/api/finance-statements/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT ${FIN_STMT_LIST_COLS}, data FROM finance_statements WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('FINANCE STATEMENT FETCH ERROR:', err);
    res.status(500).json({ error: 'Error fetching the statement' });
  }
});

app.post('/api/finance-statements', async (req, res) => {
  const b = req.body || {};
  const client = String(b.client_name || '').trim();
  if (!client || !b.data || typeof b.data !== 'object') return res.status(400).json({ error: 'Client and statement are required' });
  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n * 100) / 100; };
  const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
  try {
    const result = await pool.query(
      `INSERT INTO finance_statements (client_name, date_from, date_to, statement_date, unpaid_only, invoice_count, invoiced, paid, balance, data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${FIN_STMT_LIST_COLS}`,
      [client, day(b.date_from), day(b.date_to), day(b.statement_date) || new Date().toISOString().slice(0, 10), !!b.unpaid_only,
       parseInt(b.invoice_count, 10) || 0, num(b.invoiced), num(b.paid), num(b.balance), JSON.stringify(b.data), String(b.created_by || '').slice(0, 100) || recycleWho(req)]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('FINANCE STATEMENT SAVE ERROR:', err);
    res.status(500).json({ error: 'Error saving the statement' });
  }
});

app.delete('/api/finance-statements/:id', async (req, res) => {
  try {
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'finance_statement', (s) => ({ label: `Statement: ${s.client_name}`, detail: `${s.date_from ? String(s.date_from).slice(0, 10) : ''} to ${s.date_to ? String(s.date_to).slice(0, 10) : ''}` }),
        [{ table: 'finance_statements', where: 'id = $1', params: [req.params.id] }]);
      await db.query('DELETE FROM finance_statements WHERE id = $1', [req.params.id]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error('FINANCE STATEMENT DELETE ERROR:', err);
    res.status(500).json({ error: 'Error deleting the statement' });
  }
});

ensureFinanceTables().catch(err => console.error('Could not create finance tables:', err));

// ================= RSS IN-HOUSE TRAINING: "WHAT I LEARNED AT RSS" =================
// Built automatically from each person's weekly task list, plus entries people add by hand.
// Weekly tasks about the Yes Program, the Yes module or YouTube videos are left out.
// Makes a short topic from a weekly task sentence: "Deployed the rss online to azure" -> "Azure Deployment".
// It is a best guess; people can change the topic themselves.
const TOPIC_ACRONYMS = new Set(['rss','hr','it','sherq','kpi','pdf','api','sql','css','html','vat','iso','ohs','ppe','hira','coid','sars','uif','cv','ui','ux','js','ai','erp','crm','ms','sa']);
const TOPIC_VERB_NOUNS = {
  deploy: 'Deployment', deployed: 'Deployment', deploying: 'Deployment',
  develop: 'Development', developed: 'Development', developing: 'Development',
  test: 'Testing', tested: 'Testing', testing: 'Testing',
  design: 'Design', designed: 'Design', designing: 'Design',
  implement: 'Implementation', implemented: 'Implementation',
  install: 'Installation', installed: 'Installation',
  configure: 'Configuration', configured: 'Configuration',
  migrate: 'Migration', migrated: 'Migration',
  integrate: 'Integration', integrated: 'Integration',
  research: 'Research', researched: 'Research',
  review: 'Review', reviewed: 'Review',
  plan: 'Planning', planned: 'Planning',
  train: 'Training', trained: 'Training',
  present: 'Presentation', presented: 'Presentation',
  debug: 'Debugging', debugged: 'Debugging', fixed: 'Fixes', fix: 'Fixes'
};
const TOPIC_LEAD_VERBS = /^(i\s+)?(worked\s+on|working\s+on|work\s+on|learned|learnt|learning|learn|did|do|done|started|start|continued|continue|completed|complete|finished|finish|created|create|built|build|made|make|updated|update|added|add|set\s?up|setup|wrote|write|written|practiced|practised|practice|studied|study|attended|attend|watched|read|reading|explored|explore|improved|improve|prepared|prepare|worked)\b[\s,:-]*/i;
const TOPIC_FILLER = new Set(['the','a','an','my','our','their','his','her','its','this','that','these','those','how','to','about','on','of','and','some','new','with','using','in','for','at','by','from','into','up','out','over','also','then','just','online','current','whole','again','too','more','further','still','today','yesterday']);
function shortTopic(sentence) {
  const original = String(sentence || '').replace(/\s+/g, ' ').trim().replace(/[.!?;,]+$/, '');
  if (!original) return '';
  let rest = original.replace(/^(i\s+)/i, '');
  let noun = '';
  const first = (rest.split(/\s+/)[0] || '').toLowerCase();
  if (TOPIC_VERB_NOUNS[first]) { noun = TOPIC_VERB_NOUNS[first]; rest = rest.split(/\s+/).slice(1).join(' '); }
  else { rest = rest.replace(TOPIC_LEAD_VERBS, ''); rest = rest.replace(/^(how\s+to\s+|about\s+|the\s+|a\s+|an\s+)+/i, ''); }
  let words = rest.split(/\s+/).filter(Boolean);
  if (noun) {
    // "the rss online to azure": the part after the last "to/on/in/using/with/for/at" is what it was about
    const idx = words.map(w => w.toLowerCase()).reduce((acc, w, i) => (['to','on','in','using','with','for','at','into'].includes(w) ? i : acc), -1);
    if (idx >= 0 && idx < words.length - 1) words = words.slice(idx + 1);
  }
  words = words.filter(w => !TOPIC_FILLER.has(w.toLowerCase())).slice(0, noun ? 2 : 4);
  const fmt = w => TOPIC_ACRONYMS.has(w.toLowerCase().replace(/[^a-z]/g, '')) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const parts = words.map(fmt);
  if (noun) parts.push(noun);
  const result = parts.join(' ').trim();
  if (result) return result;
  return original.split(/\s+/).slice(0, 5).map(fmt).join(' ');
}

async function ensureLearnedTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rss_learned_entries (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      topic TEXT NOT NULL,
      learned TEXT,
      learned_date DATE,
      source VARCHAR(10) NOT NULL DEFAULT 'manual',
      source_key TEXT,
      training_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`ALTER TABLE rss_learned_entries ADD COLUMN IF NOT EXISTS source_text TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS rss_learned_source_uq ON rss_learned_entries (employee_id, source_key) WHERE source_key IS NOT NULL`);
}

function learnedNorm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
const LEARNED_EXCLUDE = /youtube|you\s*tube|yes\s*(program|programme|module)/i;
const LEARNED_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// Copies the weekly task lists of one person into their learned list. Safe to run again and again:
// the same task in the same week is never added twice, and nothing the person typed is ever overwritten.
async function syncLearnedFromWeekly(employeeId) {
  const trainings = await pool.query(
    `SELECT id, extra_data FROM trainings WHERE category = 'RSS In-House Training' AND created_by::text = $1::text`, [String(employeeId)]);
  const liveIds = [];
  const wanted = [];
  for (const t of trainings.rows) {
    liveIds.push(t.id);
    const weekly = t.extra_data && t.extra_data.weekly_tasks;
    const desired = new Map();
    if (weekly && weekly.week_start && weekly.days) {
      const start = new Date(String(weekly.week_start).split('T')[0] + 'T12:00:00Z');
      LEARNED_DAYS.forEach((day, idx) => {
        const d = new Date(start); d.setUTCDate(start.getUTCDate() + idx);
        const ymd = d.toISOString().split('T')[0];
        (Array.isArray(weekly.days[day]) ? weekly.days[day] : []).forEach(text => {
          const topic = String(text || '').trim();
          if (!topic || LEARNED_EXCLUDE.test(topic)) return;
          desired.set(`${t.id}|${day}|${learnedNorm(topic)}`, { topic, ymd, key: `${t.id}|${day}|${learnedNorm(topic)}`, trainingId: t.id });
        });
      });
    }
    // A task that was removed from the weekly list also disappears here, unless the person already wrote what they learned
    await pool.query(
      `DELETE FROM rss_learned_entries WHERE employee_id = $1 AND source = 'weekly' AND training_id = $2 AND COALESCE(TRIM(learned),'') = '' AND NOT (source_key = ANY($3::text[]))`,
      [employeeId, t.id, Array.from(desired.keys())]);
    desired.forEach(v => wanted.push(v));
  }
  await pool.query(
    `DELETE FROM rss_learned_entries WHERE employee_id = $1 AND source = 'weekly' AND COALESCE(TRIM(learned),'') = '' AND NOT (training_id = ANY($2::int[]))`,
    [employeeId, liveIds]);

  // Oldest first, so when the same topic comes up again later, the first time stays and the repeat is not added
  wanted.sort((x, y) => x.ymd.localeCompare(y.ymd) || x.key.localeCompare(y.key));
  for (const v of wanted) {
    const short = shortTopic(v.topic);
    const exists = await pool.query(
      `SELECT 1 FROM rss_learned_entries WHERE employee_id = $1 AND (source_key = $2 OR (source <> 'hidden' AND (LOWER(REGEXP_REPLACE(TRIM(topic), '\\s+', ' ', 'g')) = $3 OR LOWER(REGEXP_REPLACE(TRIM(topic), '\\s+', ' ', 'g')) = $4))) LIMIT 1`,
      [employeeId, v.key, learnedNorm(short), learnedNorm(v.topic)]);
    if (!exists.rows.length) {
      await pool.query(
        `INSERT INTO rss_learned_entries (employee_id, topic, source_text, learned_date, source, source_key, training_id) VALUES ($1,$2,$3,$4,'weekly',$5,$6)
         ON CONFLICT DO NOTHING`, [employeeId, short, v.topic, v.ymd, v.key, v.trainingId]);
    }
  }

  // Entries made by older versions: keep the long sentence as the source and give the topic a short name
  // (only when the topic was never changed by the person), and drop anything about the Yes Program / Yes module / YouTube.
  const mine = await pool.query(`SELECT id, topic, source_text, source_key FROM rss_learned_entries WHERE employee_id = $1 AND source = 'weekly'`, [employeeId]);
  for (const r of mine.rows) {
    if (LEARNED_EXCLUDE.test(r.source_text || r.topic)) {
      await pool.query('DELETE FROM rss_learned_entries WHERE id = $1', [r.id]);
    } else if (r.source_text == null) {
      const unchanged = learnedNorm(r.topic) === learnedNorm(String(r.source_key || '').split('|').slice(2).join('|'));
      await pool.query('UPDATE rss_learned_entries SET source_text = $2, topic = $3 WHERE id = $1', [r.id, r.topic, unchanged ? shortTopic(r.topic) : r.topic]);
    }
  }

  // Clean up repeats that already exist: the same topic is shown once. Anything the person typed is never removed.
  const all = await pool.query(
    `SELECT id, topic, learned, source, to_char(learned_date,'YYYY-MM-DD') AS d FROM rss_learned_entries WHERE employee_id = $1 AND source <> 'hidden' ORDER BY learned_date ASC NULLS LAST, id ASC`, [employeeId]);
  const groups = new Map();
  all.rows.forEach(r => { const k = learnedNorm(r.topic); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const keeper = rows.find(r => learnedNorm(r.learned)) || rows[0];
    for (const r of rows) {
      if (r.id !== keeper.id && r.source === 'weekly' && !learnedNorm(r.learned)) {
        await pool.query('DELETE FROM rss_learned_entries WHERE id = $1', [r.id]);
      }
    }
  }
}

const LEARNED_COLS = `id, employee_id, topic, source_text, learned, to_char(learned_date,'YYYY-MM-DD') AS learned_date, source`;

app.get('/api/learned-entries', async (req, res) => {
  const { employee_id } = req.query;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
  try {
    await syncLearnedFromWeekly(employee_id);
    const result = await pool.query(
      `SELECT ${LEARNED_COLS} FROM rss_learned_entries WHERE employee_id = $1 AND source <> 'hidden' ORDER BY learned_date DESC NULLS LAST, id DESC`, [employee_id]);
    res.json(result.rows);
  } catch (err) {
    console.error('LEARNED ENTRIES FETCH ERROR:', err);
    res.status(500).json({ error: 'Error fetching learned entries' });
  }
});

// The same topic is shown once per person: a second entry with the same topic is refused (click the existing one to add more).
async function learnedIsDuplicate(employeeId, topic, learned, ignoreId) {
  const r = await pool.query(
    `SELECT 1 FROM rss_learned_entries WHERE employee_id = $1 AND source <> 'hidden' AND LOWER(REGEXP_REPLACE(TRIM(topic), '\\s+', ' ', 'g')) = $2 AND ($3::int IS NULL OR id <> $3) LIMIT 1`,
    [employeeId, learnedNorm(topic), ignoreId || null]);
  return r.rows.length > 0;
}

app.post('/api/learned-entries', async (req, res) => {
  const { employee_id, topic, learned, learned_date } = req.body;
  if (!employee_id || !String(topic || '').trim()) return res.status(400).json({ error: 'Topic is required' });
  try {
    if (await learnedIsDuplicate(employee_id, topic, learned)) {
      return res.status(409).json({ error: 'This topic is already in your Learning Log. Click it there to add more to "What I learned".' });
    }
    const result = await pool.query(
      `INSERT INTO rss_learned_entries (employee_id, topic, learned, learned_date, source) VALUES ($1,$2,$3,$4,'manual') RETURNING ${LEARNED_COLS}`,
      [employee_id, String(topic).trim(), String(learned || '').trim() || null, learned_date || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('LEARNED ENTRY CREATE ERROR:', err);
    res.status(500).json({ error: 'Error saving entry' });
  }
});

app.patch('/api/learned-entries/:id', async (req, res) => {
  const { topic, learned, learned_date } = req.body;
  if (!String(topic || '').trim()) return res.status(400).json({ error: 'Topic is required' });
  try {
    const cur = await pool.query('SELECT employee_id FROM rss_learned_entries WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    if (await learnedIsDuplicate(cur.rows[0].employee_id, topic, learned, req.params.id)) {
      return res.status(409).json({ error: 'This topic is already in your Learning Log. Click it there to add more to "What I learned".' });
    }
    const result = await pool.query(
      `UPDATE rss_learned_entries SET topic=$2, learned=$3, learned_date=$4, updated_at=NOW() WHERE id=$1 RETURNING ${LEARNED_COLS}`,
      [req.params.id, String(topic).trim(), String(learned || '').trim() || null, learned_date || null]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('LEARNED ENTRY UPDATE ERROR:', err);
    res.status(500).json({ error: 'Error saving entry' });
  }
});

app.delete('/api/learned-entries/:id', async (req, res) => {
  try {
    // An entry that came from the weekly list is only hidden, otherwise the next sync would add it again
    await pool.query(`UPDATE rss_learned_entries SET source = 'hidden' WHERE id = $1 AND source = 'weekly'`, [req.params.id]);
    await recycleTx(async (db) => {
      await recycleCapture(db, req, 'learned_entry', (l) => ({ label: l.topic || 'Learning entry', detail: l.learned ? String(l.learned).slice(0, 150) : null }),
        [{ table: 'rss_learned_entries', where: `id = $1 AND source = 'manual'`, params: [req.params.id] }]);
      await db.query(`DELETE FROM rss_learned_entries WHERE id = $1 AND source = 'manual'`, [req.params.id]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error('LEARNED ENTRY DELETE ERROR:', err);
    res.status(500).json({ error: 'Error deleting entry' });
  }
});

ensureLearnedTables().catch(err => console.error('Could not create learned entries table:', err));

// Start Server
app.listen(PORT, () => {
  console.log(`RSS Online server is running on port ${PORT}`);
});