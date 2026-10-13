// Kangodrop website + customer portal API
// Serves the one-page site from /public and a small JSON API under /api.
require('dotenv').config();
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { query, init, saveAdmin } = require('./db');
const papertrail = require('./papertrail');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET is missing or shorter than 32 characters. Set it in .env (see .env.example).');
  process.exit(1);
}

const STATUSES = ['pending', 'approved', 'scheduled', 'delivered', 'cancelled'];
const AREAS = ['Rauma', 'Eurajoki', 'Rauma and Eurajoki'];
const FORMATS = ['Flyer A5', 'Flyer A4', 'Flyer DL', 'Catalogue / brochure', 'Addressed letter', 'Local notice'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const app = express();
app.set('trust proxy', 1); // behind Railway / Netlify / AWS load balancer
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts. Wait 15 minutes and try again.' } });
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many messages. Try again later.' } });

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, company: u.company, email: u.email, phone: u.phone, created_at: u.created_at });
const sign = (u) => jwt.sign({ sub: u.id, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Please log in.' });
  try {
    const payload = jwt.verify(t, JWT_SECRET);
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!rows[0]) return res.status(401).json({ error: 'Please log in again.' });
    req.user = rows[0];
    next();
  } catch (e) {
    res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' }));

// ---------- Health ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Auth ----------
app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const company = str(req.body.company), name = str(req.body.name), phone = str(req.body.phone, 40);
  const email = str(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!company || !name) return res.status(400).json({ error: 'Fill in the company and contact person.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'The password needs at least 8 characters.' });

  const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (exists.rows[0]) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await query(
    `INSERT INTO users (role, company, name, email, phone, password_hash) VALUES ('customer', $1, $2, $3, $4, $5) RETURNING *`,
    [company, name, email, phone || null, hash]
  );
  res.status(201).json({ token: sign(rows[0]), user: publicUser(rows[0]) });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const email = str(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  const u = rows[0];
  const wrong = () => res.status(401).json({ error: 'Email or password is incorrect.' });

  // Customers are checked here only; their passwords never go to PaperTrail.
  if (u && u.role !== 'admin') {
    if (!await bcrypt.compare(password, u.password_hash)) return wrong();
    return res.json({ token: sign(u), user: publicUser(u) });
  }

  // Anyone else may be the admin, whose account lives in PaperTrail. Ask PaperTrail; when it cannot answer,
  // use the copy saved at the admin's last successful sign-in.
  if (!email || !password) return wrong();
  const pt = await papertrail.adminLogin(email, password);
  if (pt.result === 'ok') {
    const admin = await saveAdmin(pt.admin, password);
    return res.json({ token: sign(admin), user: publicUser(admin) });
  }
  if (pt.result === 'offline' && u && u.papertrail_id && await bcrypt.compare(password, u.password_hash)) {
    return res.json({ token: sign(u), user: publicUser(u) });
  }
  wrong();
}));

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- Campaigns ----------
const CAMPAIGN_SELECT = `
  SELECT c.*, u.company, u.name AS contact_name, u.email AS contact_email
  FROM campaigns c JOIN users u ON u.id = c.user_id`;

app.get('/api/campaigns', auth, wrap(async (req, res) => {
  const { rows } = req.user.role === 'admin'
    ? await query(`${CAMPAIGN_SELECT} ORDER BY c.created_at DESC`)
    : await query(`${CAMPAIGN_SELECT} WHERE c.user_id = $1 ORDER BY c.created_at DESC`, [req.user.id]);
  res.json({ campaigns: rows });
}));

app.post('/api/campaigns', auth, wrap(async (req, res) => {
  if (req.user.role !== 'customer') return res.status(403).json({ error: 'Only customer accounts can book campaigns.' });
  const title = str(req.body.title, 120), area = str(req.body.area), format = str(req.body.format);
  const quantity = parseInt(req.body.quantity, 10);
  const start = str(req.body.start_date, 10), notes = str(req.body.notes, 2000);
  if (!title) return res.status(400).json({ error: 'Give the campaign a name.' });
  if (!AREAS.includes(area)) return res.status(400).json({ error: 'Choose an area we deliver to.' });
  if (!FORMATS.includes(format)) return res.status(400).json({ error: 'Choose a material type.' });
  if (!Number.isInteger(quantity) || quantity < 50 || quantity > 1000000) return res.status(400).json({ error: 'Enter the number of households (at least 50).' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ error: 'Choose the date delivery should start.' });

  const ins = await query(
    `INSERT INTO campaigns (user_id, title, area, format, quantity, start_date, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [req.user.id, title, area, format, quantity, start, notes || null]
  );
  const { rows } = await query(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [ins.rows[0].id]);
  res.status(201).json({ campaign: rows[0] });
}));

app.patch('/api/campaigns/:id', auth, adminOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = str(req.body.status, 20);
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  const upd = await query('UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING id', [status, id]);
  if (!upd.rows[0]) return res.status(404).json({ error: 'Campaign not found.' });
  const { rows } = await query(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [id]);
  res.json({ campaign: rows[0] });
}));

// ---------- Coverage: PaperTrail's delivery routes, for planning a marketing area ----------
// Region -> city -> route lists and a route's road line. Only names, counts and the line reach the browser.
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
const CITY_KEYS = ['id', 'name', 'route_count', 'mailbox_count'];
const REGION_KEYS = [...CITY_KEYS, 'city_count'];
const ROUTE_KEYS = ['id', 'name', 'mailbox_count', 'apartment_count'];
const MAP_KEYS = [...ROUTE_KEYS, 'city', 'region', 'path', 'meters'];

const coverage = (pathOf, shape) => wrap(async (req, res) => {
  const id = req.params.id === undefined ? null : parseInt(req.params.id, 10);
  if (id !== null && !(id > 0)) return res.status(404).json({ error: 'Not found.' });
  const r = await papertrail.catalog(pathOf(id));
  if (r.status === 200) return res.json(shape(r.data));
  if (r.status === 404) return res.status(404).json({ error: 'This route is not available right now.' });
  res.status(503).json({ error: 'Route data is temporarily unavailable. Please try again later.' });
});
const list = (keys) => (rows) => ({ items: (Array.isArray(rows) ? rows : []).map((x) => pick(x, keys)) });

app.get('/api/coverage/config', auth, (req, res) => res.json({ mapsKey: process.env.GOOGLE_MAPS_API_KEY || '' }));
app.get('/api/coverage/regions', auth, coverage(() => '/regions', list(REGION_KEYS)));
app.get('/api/coverage/regions/:id/cities', auth, coverage((id) => `/regions/${id}/cities`, list(CITY_KEYS)));
app.get('/api/coverage/cities/:id/routes', auth, coverage((id) => `/cities/${id}/routes`, list(ROUTE_KEYS)));
app.get('/api/coverage/routes/:id/map', auth, coverage((id) => `/routes/${id}/map`, (m) => ({ route: pick(m, MAP_KEYS) })));

// ---------- Admin ----------
app.get('/api/admin/customers', auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await query(`SELECT * FROM users WHERE role = 'customer' ORDER BY created_at DESC`);
  res.json({ customers: rows.map(publicUser) });
}));

// Reports come from PaperTrail (its backend/reports/index.js). Each one answers { title, columns, rows }.
const REPORTS_DOWN = 'Reports are temporarily unavailable. Please try again later.';
app.get('/api/admin/reports', auth, adminOnly, wrap(async (req, res) => {
  const r = await papertrail.reports('');
  if (r.status !== 200) return res.status(503).json({ error: REPORTS_DOWN });
  res.json({ reports: (Array.isArray(r.data) ? r.data : []).map((x) => pick(x, ['id', 'title', 'description'])) });
}));

app.get('/api/admin/reports/:id', auth, adminOnly, wrap(async (req, res) => {
  if (!/^[a-z0-9-]{1,60}$/.test(req.params.id)) return res.status(404).json({ error: 'Report not found.' });
  const qs = new URLSearchParams(Object.entries(req.query).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, str(v)])).toString();
  const r = await papertrail.reports(`/${req.params.id}${qs ? '?' + qs : ''}`);
  if (r.status === 200) return res.json({ report: r.data });
  if (r.status === 404) return res.status(404).json({ error: 'Report not found.' });
  if (r.status === 400) return res.status(400).json({ error: r.data.error || 'Check the report options.' });
  res.status(503).json({ error: REPORTS_DOWN });
}));

// Route owners live in PaperTrail: the admin creates them here and they sign in to the app.
app.post('/api/admin/route-owners', auth, adminOnly, wrap(async (req, res) => {
  const owner = {
    name: str(req.body.name, 120), email: str(req.body.email).toLowerCase(), password: typeof req.body.password === 'string' ? req.body.password : '',
    phone: str(req.body.phone, 40), city: str(req.body.city, 80)
  };
  if (!owner.name) return res.status(400).json({ error: "Fill in the route owner's name." });
  if (!EMAIL_RE.test(owner.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (owner.password.length < 8 || owner.password.length > 100) return res.status(400).json({ error: 'The password needs 8 to 100 characters.' });
  const r = await papertrail.createOwner(owner);
  if (r.status === 201) return res.status(201).json({ owner: pick(r.data, ['id', 'name', 'email', 'phone', 'city']) });
  if (r.status === 409) return res.status(409).json({ error: 'An account with this email already exists in the app.' });
  if (r.status === 400) return res.status(400).json({ error: r.data.error || "Check the route owner's details." });
  res.status(503).json({ error: 'The app is not reachable right now. Please try again later.' });
}));

app.get('/api/admin/messages', auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM messages ORDER BY created_at DESC LIMIT 200');
  res.json({ messages: rows });
}));

// ---------- Contact form ----------
app.post('/api/contact', contactLimiter, wrap(async (req, res) => {
  const name = str(req.body.name, 120), email = str(req.body.email).toLowerCase(), message = str(req.body.message, 4000);
  if (!name || !message) return res.status(400).json({ error: 'Fill in your name and a message.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email so we can reply.' });
  await query('INSERT INTO messages (name, email, message) VALUES ($1, $2, $3)', [name, email, message]);
  res.status(201).json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Website ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

if (require.main === module) {
  if (!papertrail.configured()) console.warn('PAPERTRAIL_API_URL / PAPERTRAIL_API_KEY are not set: the admin can only sign in with the copy saved at an earlier sign-in.');
  init().then(() => app.listen(PORT, () => console.log(`Kangodrop running on http://localhost:${PORT}`)))
    .catch((e) => { console.error('Database setup failed:', e); process.exit(1); });
}
module.exports = { app, init };
