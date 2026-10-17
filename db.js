// Database connection, schema setup and admin seeding.
// Uses PostgreSQL via DATABASE_URL. Set USE_MEMORY_DB=true to run with an
// in-memory database for local testing (data is lost on restart).
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// DB_SCHEMA puts the website's tables in their own schema, so it can share one database with the app
// (whose tables stay in "public"). Unset: tables go in "public" as before.
const DB_SCHEMA = process.env.USE_MEMORY_DB === 'true' ? '' : (process.env.DB_SCHEMA || '').trim();
if (DB_SCHEMA && !/^[a-z_][a-z0-9_]{0,62}$/.test(DB_SCHEMA)) {
  console.error('DB_SCHEMA must be a lower-case name such as web.');
  process.exit(1);
}

let pool;
if (process.env.USE_MEMORY_DB === 'true') {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();
} else {
  const { Pool } = require('pg');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to .env, or set USE_MEMORY_DB=true for a quick local test.');
    process.exit(1);
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    options: DB_SCHEMA ? `-c search_path=${DB_SCHEMA}` : undefined
  });
}

const query = (text, params) => pool.query(text, params);

async function init() {
  if (DB_SCHEMA) await query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const stmt of schema.split(';').map((s) => s.trim()).filter(Boolean)) {
    await query(stmt);
  }

  // The admin signs in with their PaperTrail account. Admins created here before that (from ADMIN_EMAIL) are removed.
  const old = await query(`DELETE FROM users WHERE role = 'admin' AND papertrail_id IS NULL RETURNING email`);
  for (const r of old.rows) console.log(`Removed the website-only admin ${r.email}: the admin now signs in with their PaperTrail account.`);
}

// Keep the local copy of the PaperTrail admin up to date after they signed in there (see papertrail.js).
// Its password_hash is what lets them sign in while PaperTrail is offline.
async function saveAdmin(admin, password) {
  const email = String(admin.email).trim().toLowerCase();
  const hash = await bcrypt.hash(password, 12);
  // a previous admin copy that used this email
  await query(`DELETE FROM users WHERE role = 'admin' AND email = $1 AND (papertrail_id IS NULL OR papertrail_id <> $2)`, [email, admin.id]);
  const upd = await query(
    `UPDATE users SET email = $1, name = $2, password_hash = $3 WHERE role = 'admin' AND papertrail_id = $4 RETURNING *`,
    [email, admin.name, hash, admin.id]
  );
  if (upd.rows[0]) return upd.rows[0];
  const ins = await query(
    `INSERT INTO users (role, company, name, email, password_hash, papertrail_id) VALUES ('admin', 'Kangodrop', $1, $2, $3, $4) RETURNING *`,
    [admin.name, email, hash, admin.id]
  );
  return ins.rows[0];
}

module.exports = { query, init, pool, saveAdmin };
