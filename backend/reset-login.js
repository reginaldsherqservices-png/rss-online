// Run this from the backend folder to see the logins or to set a new password.
//   node reset-login.js --list
//   node reset-login.js "Milly" "MyNewPassword123"
// DO NOT commit or push this file to GitHub.
require('dotenv').config();
const pool = require('./db');

(async () => {
  const [a, b] = process.argv.slice(2);
  try {
    if (a === '--list' || !a) {
      const r = await pool.query('SELECT id, username, role FROM users ORDER BY id');
      console.table(r.rows);
      console.log('To set a new password:  node reset-login.js "username" "NewPassword"');
    } else {
      if (!b || b.length < 6) { console.log('Please give a new password of at least 6 characters.'); }
      else {
        const r = await pool.query('UPDATE users SET password = $1 WHERE username = $2 RETURNING username, role', [b, a]);
        console.log(r.rows.length ? `Done. The password for "${r.rows[0].username}" (${r.rows[0].role}) was changed.` : `No user called "${a}" was found. Run with --list to see the usernames.`);
      }
    }
  } catch (e) { console.error('Something went wrong:', e.message); }
  process.exit(0);
})();
