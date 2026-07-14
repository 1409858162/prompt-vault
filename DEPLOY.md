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
