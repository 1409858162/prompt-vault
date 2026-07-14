// Vercel serverless entry. Re-exports the same Express app the local dev
// server uses, so route definitions stay in one place (server.js).
//
// Vercel's "@vercel/node" runtime expects a default export of the request
// handler — that's exactly what `app` from server.js is.

import app from '../server.js';

export default app;