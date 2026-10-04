// Calls to the PaperTrail delivery app (server to server, never from the browser).
// PAPERTRAIL_API_URL is its backend address, PAPERTRAIL_API_KEY the shared key (WEBSITE_API_KEY over there).
const BASE = (process.env.PAPERTRAIL_API_URL || '').replace(/\/+$/, '');
const KEY = process.env.PAPERTRAIL_API_KEY || '';
const TIMEOUT_MS = 5000;

const configured = () => Boolean(BASE && KEY);

async function call(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Is this the admin's email and password? The admin account lives in PaperTrail.
//   { result: 'ok', admin: { id, name, email } }   yes
//   { result: 'rejected' }                         no
//   { result: 'offline' }                          PaperTrail could not answer (down, unreachable or misconfigured)
async function adminLogin(email, password) {
  if (!configured()) return { result: 'offline' };
  try {
    const r = await call('POST', '/website/admin-login', { email, password });
    if (r.status === 200 && r.data.admin) return { result: 'ok', admin: r.data.admin };
    if (r.status === 401 && r.data.error === 'Invalid credentials') return { result: 'rejected' };
    console.error(`PaperTrail admin sign-in answered ${r.status}: ${r.data.error || 'no message'}`);
  } catch (e) {
    console.error(`PaperTrail is unreachable: ${e.message}`);
  }
  return { result: 'offline' };
}

// GET something from PaperTrail. Resolves to { status, data }; status 0 means PaperTrail could not answer.
async function read(path) {
  if (!configured()) return { status: 0, data: {} };
  try {
    const r = await call('GET', path);
    if (r.status >= 500 || r.status === 401) console.error(`PaperTrail ${path} answered ${r.status}: ${r.data.error || 'no message'}`);
    return r;
  } catch (e) {
    console.error(`PaperTrail is unreachable: ${e.message}`);
    return { status: 0, data: {} };
  }
}

// the route catalog: regions, cities, routes, a route's road line
const catalog = (path) => read(`/catalog${path}`);
// admin reports: the list, or one report (path '/<id>?<query>')
const reports = (path) => read(`/reports${path}`);

module.exports = { configured, adminLogin, catalog, reports };
