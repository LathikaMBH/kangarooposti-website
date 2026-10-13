// End-to-end API test against an in-memory database, with a stand-in for PaperTrail (where the admin account lives).
process.env.USE_MEMORY_DB = 'true';
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.PAPERTRAIL_API_KEY = 'test-papertrail-key-that-is-32-characters-plus';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

// Stand-in PaperTrail: one admin. `paperTrail.up = false` makes it answer like a server that is down.
const paperTrail = { up: true, calls: 0, admin: { id: 7, name: 'Admin', email: 'admin@kangodrop.com', password: 'pt-admin-pass-1' } };
const fake = express().use(express.json()).post('/api/website/admin-login', (req, res) => {
  paperTrail.calls++;
  if (!paperTrail.up) return res.status(503).json({ error: 'Down' });
  if (req.get('x-api-key') !== process.env.PAPERTRAIL_API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  const { id, name, email, password } = paperTrail.admin;
  if (req.body.email !== email || req.body.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ admin: { id, name, email } });
});
// route catalog; `secret` stands for anything PaperTrail might add that customers must not see
const catalog = { '/regions': [{ id: 1, name: 'Satakunta', city_count: 1, route_count: 1, mailbox_count: 120, secret: 'x' }],
  '/regions/1/cities': [{ id: 1, name: 'Rauma', route_count: 1, mailbox_count: 120 }],
  '/cities/1/routes': [{ id: 9, name: 'Isorontie 2', mailbox_count: 120, apartment_count: 3, secret: 'x' }],
  '/routes/9/map': { id: 9, name: 'Isorontie 2', mailbox_count: 120, apartment_count: 3, city: 'Rauma', region: 'Satakunta', path: '_p~iF~ps|U_ulLnnqC', meters: 900, secret: 'x' } };
fake.get('/api/reports', (req, res) => paperTrail.up ? res.json([{ id: 'routes-per-city', title: 'Routes per city', description: 'd', secret: 'x' }]) : res.status(503).json({ error: 'Down' }));
fake.get('/api/reports/:id', (req, res) => {
  if (req.params.id !== 'routes-per-city') return res.status(404).json({ error: 'Report not found' });
  res.json({ id: req.params.id, title: 'Routes per city', columns: [{ key: 'city', label: 'City' }], rows: [{ city: 'Rauma' }], query: req.query });
});
// route owners: the stand-in keeps the emails it has seen
const ownerEmails = new Set();
fake.post('/api/website/owners', (req, res) => {
  if (!paperTrail.up) return res.status(503).json({ error: 'Down' });
  if (req.get('x-api-key') !== process.env.PAPERTRAIL_API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  if (req.body.phone === 'bad') return res.status(400).json({ error: 'Enter the phone number with a country code' });
  if (ownerEmails.has(req.body.email)) return res.status(409).json({ error: 'Email already exists' });
  ownerEmails.add(req.body.email);
  res.status(201).json({ id: 5, name: req.body.name, email: req.body.email, role: 'route_owner', city: req.body.city, phone: req.body.phone, can_ride: false });
});
fake.get('/api/catalog/*', (req, res) => {
  if (!paperTrail.up) return res.status(503).json({ error: 'Down' });
  const data = catalog[req.path.slice('/api/catalog'.length)];
  data ? res.json(data) : res.status(404).json({ error: 'Route not found' });
});

let base, server, fakeServer;
const call = async (method, path, body, token) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

test.before(async () => {
  fakeServer = fake.listen(0);
  process.env.PAPERTRAIL_API_URL = `http://127.0.0.1:${fakeServer.address().port}`;
  const { app, init } = require('../server'); // after PAPERTRAIL_API_URL is known
  await init();
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => { server.close(); fakeServer.close(); });

test('full customer and admin flow', async () => {
  assert.equal((await call('GET', '/health')).data.ok, true);

  const reg = await call('POST', '/auth/register', { company: 'Testi Oy', name: 'Matti', email: 'Matti@Testi.fi', password: 'secret123' });
  assert.equal(reg.status, 201); assert.equal(reg.data.user.role, 'customer'); assert.ok(!('password_hash' in reg.data.user));
  assert.equal((await call('POST', '/auth/register', { company: 'X', name: 'Y', email: 'matti@testi.fi', password: 'secret123' })).status, 409);
  assert.equal((await call('POST', '/auth/register', { company: 'X', name: 'Y', email: 'bad', password: 'secret123' })).status, 400);

  const before = paperTrail.calls;
  assert.equal((await call('POST', '/auth/login', { email: 'matti@testi.fi', password: 'wrong-pass' })).status, 401);
  const login = await call('POST', '/auth/login', { email: 'matti@testi.fi', password: 'secret123' });
  assert.equal(login.status, 200);
  assert.equal(paperTrail.calls, before, 'customer passwords are never sent to PaperTrail');
  assert.equal((await call('POST', '/auth/login', { email: 'nobody@testi.fi', password: 'wrong-pass' })).status, 401);
  const ct = login.data.token;

  const camp = await call('POST', '/campaigns', { title: 'Joulu', area: 'Rauma', format: 'Flyer A5', quantity: 2000, start_date: '2026-12-07' }, ct);
  assert.equal(camp.status, 201); assert.equal(camp.data.campaign.status, 'pending'); assert.equal(camp.data.campaign.company, 'Testi Oy');
  assert.equal((await call('POST', '/campaigns', { title: 'x', area: 'Helsinki', format: 'Flyer A5', quantity: 2000, start_date: '2026-12-07' }, ct)).status, 400);
  assert.equal((await call('GET', '/campaigns', null, ct)).data.campaigns.length, 1);

  // coverage: the customer sees PaperTrail's routes, with only names, counts and the line
  assert.equal((await call('GET', '/coverage/regions')).status, 401);
  const regions = await call('GET', '/coverage/regions', null, ct);
  assert.equal(regions.status, 200); assert.equal(regions.data.items[0].name, 'Satakunta'); assert.ok(!('secret' in regions.data.items[0]));
  assert.equal((await call('GET', '/coverage/regions/1/cities', null, ct)).data.items[0].name, 'Rauma');
  const routes = await call('GET', '/coverage/cities/1/routes', null, ct);
  assert.deepEqual(routes.data.items, [{ id: 9, name: 'Isorontie 2', mailbox_count: 120, apartment_count: 3 }]);
  const map = await call('GET', '/coverage/routes/9/map', null, ct);
  assert.equal(map.data.route.path, '_p~iF~ps|U_ulLnnqC'); assert.ok(!('secret' in map.data.route));
  assert.equal((await call('GET', '/coverage/routes/8/map', null, ct)).status, 404);
  assert.equal((await call('GET', '/coverage/routes/abc/map', null, ct)).status, 404);
  assert.equal(typeof (await call('GET', '/coverage/config', null, ct)).data.mapsKey, 'string');
  paperTrail.up = false;
  assert.equal((await call('GET', '/coverage/regions', null, ct)).status, 503);
  paperTrail.up = true;

  // customer cannot use admin routes
  assert.equal((await call('GET', '/admin/customers', null, ct)).status, 403);
  assert.equal((await call('PATCH', '/campaigns/' + camp.data.campaign.id, { status: 'delivered' }, ct)).status, 403);
  assert.equal((await call('GET', '/campaigns')).status, 401);

  // the admin signs in with their PaperTrail account
  const pt = paperTrail.admin;
  assert.equal((await call('POST', '/auth/login', { email: pt.email, password: 'wrong-pass' })).status, 401);
  const admin = await call('POST', '/auth/login', { email: pt.email, password: pt.password });
  assert.equal(admin.status, 200); assert.equal(admin.data.user.role, 'admin');
  const at = admin.data.token;
  assert.equal((await call('GET', '/admin/customers', null, at)).data.customers.length, 1);
  const upd = await call('PATCH', '/campaigns/' + camp.data.campaign.id, { status: 'scheduled' }, at);
  assert.equal(upd.data.campaign.status, 'scheduled');
  assert.equal((await call('PATCH', '/campaigns/' + camp.data.campaign.id, { status: 'lost' }, at)).status, 400);

  // reports: admin only, passed through from PaperTrail
  assert.equal((await call('GET', '/admin/reports', null, ct)).status, 403);
  assert.deepEqual((await call('GET', '/admin/reports', null, at)).data.reports, [{ id: 'routes-per-city', title: 'Routes per city', description: 'd' }]);
  const rep = await call('GET', '/admin/reports/routes-per-city?from=2026-10-01', null, at);
  assert.equal(rep.data.report.rows[0].city, 'Rauma'); assert.deepEqual(rep.data.report.query, { from: '2026-10-01' });
  assert.equal((await call('GET', '/admin/reports/nope', null, at)).status, 404);
  assert.equal((await call('GET', '/admin/reports/..%2Fcatalog', null, at)).status, 404);

  // route owners: the admin creates them in PaperTrail
  const owner = { name: 'Olli Owner', email: 'Olli@Owner.fi', phone: '+358401234567', city: 'Rauma', password: 'owner-pass-1' };
  assert.equal((await call('POST', '/admin/route-owners', owner, ct)).status, 403);
  const made = await call('POST', '/admin/route-owners', owner, at);
  assert.equal(made.status, 201); assert.deepEqual(made.data.owner, { id: 5, name: 'Olli Owner', email: 'olli@owner.fi', phone: '+358401234567', city: 'Rauma' });
  assert.equal((await call('POST', '/admin/route-owners', owner, at)).status, 409);
  assert.equal((await call('POST', '/admin/route-owners', { ...owner, email: 'x@owner.fi', password: 'short' }, at)).status, 400);
  assert.equal((await call('POST', '/admin/route-owners', { ...owner, email: 'bad' }, at)).status, 400);
  assert.equal((await call('POST', '/admin/route-owners', { ...owner, email: 'y@owner.fi', phone: 'bad' }, at)).data.error, 'Enter the phone number with a country code');

  // PaperTrail down: the saved copy still works, a wrong password still fails
  paperTrail.up = false;
  assert.equal((await call('POST', '/auth/login', { email: pt.email, password: pt.password })).data.user.role, 'admin');
  assert.equal((await call('POST', '/auth/login', { email: pt.email, password: 'wrong-pass' })).status, 401);
  assert.equal((await call('POST', '/auth/login', { email: 'nobody@testi.fi', password: 'x' })).status, 401);
  assert.equal((await call('GET', '/admin/reports', null, at)).status, 503);
  assert.equal((await call('POST', '/admin/route-owners', { ...owner, email: 'z@owner.fi' }, at)).status, 503);
  paperTrail.up = true;

  // password changed in PaperTrail: the old one stops working while PaperTrail is up
  pt.password = 'pt-admin-pass-2';
  assert.equal((await call('POST', '/auth/login', { email: pt.email, password: 'pt-admin-pass-1' })).status, 401);
  assert.equal((await call('POST', '/auth/login', { email: pt.email, password: 'pt-admin-pass-2' })).status, 200);

  assert.equal((await call('POST', '/contact', { name: 'Liisa', email: 'liisa@x.fi', message: 'Hinta?' })).status, 201);
  assert.equal((await call('GET', '/admin/messages', null, at)).data.messages.length, 1);
  assert.equal((await call('GET', '/me', null, 'garbage')).status, 401);
});
