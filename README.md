# Kangodrop website (kangodrop.com)

A one-page website with a **Customer portal** for advertisers and an **admin dashboard**.

- `public/index.html`: the whole website (Home, Services, How it works, Coverage, About, Contact). The nav links scroll to each section.
- `server.js`: Express server. It serves the website and a JSON API under `/api`.
- `db.js` + `schema.sql`: PostgreSQL tables (`users`, `campaigns`, `messages`), created automatically on first start.
- `test/api.test.js`: end-to-end API test (register, login, booking, admin status change, contact form, access control, admin login through a stand-in PaperTrail).

## How the portal works

| Who | What they can do |
|---|---|
| Visitor | Click **Customer portal** (top right) → Log in or Register. Use the contact form. |
| Customer | Register with company, contact person, email and password. Book campaigns (area, material, households, delivery week). See status: Pending → Approved → Scheduled → Delivered. |
| Customer (planning) | **Plan your marketing area**: choose region and city, tick delivery routes and see them drawn on the map, with the total number of mailboxes. The routes come from the PaperTrail app (no addresses or stop pins are shown). |
| Admin | Log in through the same Customer portal button. The account role decides which dashboard opens. See all campaigns and change their status, see all customers and contact-form messages. |

Admins cannot register through the site. There is one admin for the website and the PaperTrail delivery app: the admin logs in here with their **PaperTrail** email and password. The website checks them with PaperTrail (`PAPERTRAIL_API_URL`, `PAPERTRAIL_API_KEY`) and keeps a bcrypt copy, so the admin can still log in while PaperTrail is offline. Customer passwords never leave this site.

Security: passwords are hashed with bcrypt, logins use signed JWT tokens (7 days), login and register are rate limited (20 tries per 15 min), contact form is limited to 10 per hour, and all input is validated on the server.

**Preview mode:** if `index.html` is opened without the server (e.g. double-clicked, or hosted as a static file), it runs in preview mode with sample accounts kept in memory. A yellow banner shows when this happens. When the server is running, the banner disappears and everything is stored in PostgreSQL.

## Run locally

```bash
npm install
npm run dev:memory        # in-memory DB, no Postgres needed (data is lost on restart)
# needs JWT_SECRET in .env (and PAPERTRAIL_API_URL / PAPERTRAIL_API_KEY for the admin login)
```

With a real database:

```bash
cp .env.example .env      # fill in DATABASE_URL, JWT_SECRET, PAPERTRAIL_API_URL, PAPERTRAIL_API_KEY
npm start                 # http://localhost:3000
npm test                  # runs the API tests
```

## Deploy (Railway, same as the Kangodrop app)

1. Push this folder to a new GitHub repo.
2. In Railway: **New project → Deploy from GitHub repo**, then **Add → Database → PostgreSQL**.
3. In the web service's **Variables**, add `DATABASE_URL` (reference the Postgres one), `PGSSL=true`, `JWT_SECRET`, `PAPERTRAIL_API_URL`, `PAPERTRAIL_API_KEY`.
4. Under **Settings → Networking → Custom domain**, add `kangodrop.com` and `www.kangodrop.com`, then create the CNAME records Railway shows at your domain registrar.

The same app runs on AWS (Elastic Beanstalk / App Runner + RDS PostgreSQL) with the same environment variables.

## Before going live: things to edit

- **Email address** in the Contact section (`info@kangodrop.com`). Change it if you use a different one.
- **Business ID (Y-tunnus)**: add it to the footer if you want it shown.
- **Coverage districts**: check the district chips under Coverage match the routes you actually serve.
- **Privacy notice**: the register form collects names, emails and phone numbers, so GDPR requires a privacy notice (tietosuojaseloste). Add a page and link it from the register checkbox and footer.
- The hero card is labelled "Example campaign". Its figures are illustrative.
