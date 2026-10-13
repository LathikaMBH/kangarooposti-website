# Kangodrop website

One-page marketing site for Kangodrop (flyer/letter delivery in Rauma and Eurajoki) with a customer portal and admin dashboard. Node 18+, Express, PostgreSQL. No build step, no frontend framework.

## Layout

- `server.js`: Express app. Serves `public/` and the JSON API under `/api`. Exports `{ app, init }` and only listens when run directly.
- `db.js`: Postgres pool (`DATABASE_URL`, `PGSSL`), or `pg-mem` when `USE_MEMORY_DB=true`. `init()` runs `schema.sql` (split on `;`) and removes website-only admins. `saveAdmin()` keeps the local copy of the PaperTrail admin.
- `papertrail.js`: server-to-server calls to the PaperTrail delivery app (`PAPERTRAIL_API_URL`, `PAPERTRAIL_API_KEY` sent as `X-Api-Key`). The single admin account lives in PaperTrail: login asks PaperTrail, and when it is offline falls back to the bcrypt copy saved at the last successful login (`users.papertrail_id` set). Customer logins never call PaperTrail.
- `schema.sql`: `users`, `campaigns`, `messages`. Uses `CREATE TABLE IF NOT EXISTS` only, with no migrations. Schema changes must stay idempotent.
- `public/index.html`: the whole frontend (HTML, CSS and JS in one file, about 60 KB). Colors are CSS tokens on `:root` with dark-mode overrides. It falls back to an in-memory **preview mode** with sample accounts when `/api/health` is unreachable, so frontend changes must work in both modes.
- `test/api.test.js`: one end-to-end `node:test` flow against pg-mem, with a stand-in PaperTrail for the admin login.

## Commands

```
npm install
npm test            # node --test, uses in-memory DB, no .env needed
npm start           # needs DATABASE_URL, JWT_SECRET (>=32 chars), PAPERTRAIL_API_URL, PAPERTRAIL_API_KEY
```

`npm run dev:memory` uses POSIX `VAR=x` syntax and fails in PowerShell. On Windows use `$env:USE_MEMORY_DB='true'; node server.js`.

## API

- Public: `GET /api/health`, `POST /api/auth/register`, `POST /api/auth/login` (rate limited 20/15min), `POST /api/contact` (10/hour).
- Auth (Bearer JWT, 7d): `GET /api/me`, `GET /api/campaigns` (admins see all), `POST /api/campaigns` (customers only).
- Admin: `PATCH /api/campaigns/:id` (status), `GET /api/admin/customers`, `GET /api/admin/messages`.
- Admin reports (proxied to PaperTrail's `/api/reports`): `GET /api/admin/reports` (list), `GET /api/admin/reports/:id` (one report: `{ title, columns, rows }`, query string passed on). Reports are added in PaperTrail's `backend/reports/index.js`; the Reports card renders any report as a table with CSV download.
- Admin route owners: `POST /api/admin/route-owners` creates a route owner in PaperTrail (`POST /api/website/owners` there). They sign in to the app (kangodrop.app); the `route-owners` report lists them with route and rider counts.
- Coverage (any logged-in user, proxied to PaperTrail's `/api/catalog`): `GET /api/coverage/config` (Google Maps key), `/api/coverage/regions`, `/regions/:id/cities`, `/cities/:id/routes`, `/routes/:id/map`. Only allow-listed fields (names, counts, the joined road line) are passed on: customers must never see stop pins or addresses. PaperTrail down gives 503.
- Allowed values live in `server.js`: `STATUSES`, `AREAS`, `FORMATS`. Keep them in sync with the dropdowns in `index.html`.

## Conventions

- Validate all input on the server with the `str()` helper and the allow-lists. Use parameterized queries only. Wrap async routes in `wrap()`.
- Never return `password_hash`. Map users through `publicUser()`.
- Error messages are short, plain sentences shown directly to users.
- `.env` holds real secrets. Never read it, print it or commit it. Use `.env.example` for reference.
- Deploys to Railway (see README).
