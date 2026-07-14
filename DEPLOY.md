# Prompt Vault Deployment

This archive is ready to upload and extract into the Node.js project directory,
for example `/www/wwwroot/prompt`.

## BaoTa Node.js project settings

- Project directory: `/www/wwwroot/prompt`
- Startup file: `server.js`
- Node.js: 18 or newer
- Port: use the port configured by BaoTa, or set `PORT` in `.env`
- Start command: `npm start`

## Install and configure

```bash
cd /www/wwwroot/prompt
npm install --omit=dev
cp .env.example .env
```

Edit `.env` and set unique production secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Use separate values for `JWT_SECRET`, `CONTENT_TOKEN_SECRET`, and
`CAPTCHA_SECRET`. Set `NODE_ENV=production`, `PORT`, and
`ADMIN_USER_IDS` as needed.

The bundled `data/` directory contains the current application state. Keep it
persistent and writable by the Node.js process.

## Admin commands

```bash
node admin.js help
node admin.js generate --label "buyer" --years 10
node admin.js accounts
```

After starting the project, open the domain configured in BaoTa. The login page
is served from `/login`.

---

## Vercel + TiDB Cloud (备案前用)

The Chinese ICP filing can take a while. While you wait, deploy to Vercel +
TiDB Cloud Starter (free) so the project is reachable from the public
internet. After the filing goes through, this same data can be exported and
imported back into your BaoTa MySQL.

### 1. Set up TiDB Cloud

1. Sign up at <https://tidbcloud.com> (GitHub or Google login works).
2. **Create Resource → TiDB Cloud Starter** (free).
3. Choose **AWS / Singapore** or **AWS / Tokyo** for the lowest latency from
   China.
4. Once created, click the cluster → **Connect** → **Standard Connection**.
5. Set a password, then copy the connection string. It looks like:
   ```
   mysql://3xxxxx.root:YOUR_PASSWORD@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/prompt_vault?ssl=true
   ```
6. Save the password somewhere safe — TiDB only shows it once.

### 2. Import the existing data

The dump under `prompt_vault.tidb.sql` is already cleaned (utf8mb4 collation,
no `LOCK TABLES`, no MySQL versioned comments). Push it to TiDB:

```bash
# Use a one-off Node script to import. MYSQL_URL points at the fresh TiDB.
export MYSQL_URL='mysql://3xxxxx.root:PASSWORD@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/prompt_vault?ssl=true'
node scripts/migrate-to-tidb.mjs prompt_vault.tidb.sql
```

You should see row counts for all 11 tables printed at the end.

### 3. Deploy to Vercel

1. Install the Vercel CLI (`npm i -g vercel`) or use the dashboard.
2. From the project root:
   ```bash
   vercel
   ```
   First-time setup will ask you to link a Vercel account / pick a project
   name. Say **yes** to all defaults.
3. In the Vercel dashboard → **Project → Settings → Environment Variables**,
   add the same secrets you set locally:
   - `NODE_ENV=production`
   - `JWT_SECRET=<64-char random>`
   - `CONTENT_TOKEN_SECRET=<64-char random>`
   - `CAPTCHA_SECRET=<64-char random>`
   - `MYSQL_URL=<the TiDB connection string>`
   - `ADMIN_USER_IDS=u_mriz7v6mub7rft` (your account id from the dump)
   - `TRUST_PROXY=1`
4. Re-deploy (or push to git if you connected Vercel to GitHub):
   ```bash
   vercel --prod
   ```

### 4. Verify

```bash
curl https://<your-project>.vercel.app/api/health
# or open the login page in a browser:
open https://<your-project>.vercel.app/login
```

The `lib/mysql.js` helper picks up `MYSQL_URL`, auto-enables TLS, and reuses
the same `mysql2/promise` driver the local app already uses. No code changes
needed in `server.js` or any of the domain libs.

### 5. After your ICP filing goes through

Export the data from TiDB and import it back into your local MySQL (phpmyadmin
stays usable throughout):

```bash
# Dump from TiDB (use the same MYSQL_URL you set on Vercel)
mysqldump -h gateway01.ap-southeast-1.prod.aws.tidbcloud.com \
  -P 4000 -u 3xxxxx.root -p --ssl-mode=REQUIRED \
  --skip-lock-tables --skip-comments \
  prompt_vault > backup.sql

# Import into your BaoTa MySQL (via phpmyadmin or CLI)
mysql -h 127.0.0.1 -u root -p prompt_vault < backup.sql
```

Then point your app at the local database again by removing `MYSQL_URL` from
the Vercel environment and setting `MYSQL_HOST` / `MYSQL_USER` / etc.
