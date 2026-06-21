import './lib/load-env.js';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { staging } from './routes/staging.js';
import { pipeline } from './routes/pipeline.js';
import { review } from './routes/review.js';
import { facts } from './routes/facts.js';
import { kb } from './routes/kb.js';
import { tickets } from './routes/tickets.js';
import { users } from './routes/users.js';
import { identity } from './routes/identity.js';
import { platform } from './routes/platform.js';
import { analytics } from './routes/analytics.js';
import { env } from './lib/env.js';
import { log } from './lib/logger.js';

const app = new Hono();

// Restrict CORS to the configured frontend origin(s) in production; allow all
// when WEB_ORIGIN is unset (local dev).
const allowedOrigins = env.corsOrigins();
app.use(
  '*',
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  }),
);
app.get('/health', (c) => c.json({ status: 'ok', service: 'mailmind-api' }));

// identity (/me) is mounted first so its handler resolves before any sibling
// router's `use('*')` auth middleware can run on it — /me does its own token
// check and must work for vendor-only platform admins that have no org profile.
app.route('/api', identity);
app.route('/api', staging);
app.route('/api', pipeline);
app.route('/api', review);
app.route('/api', facts);
app.route('/api', kb);
app.route('/api', tickets);
app.route('/api', users);
app.route('/api', platform);
app.route('/api', analytics);

// Single-service deploy: serve the built SPA same-origin from this server.
// Only mounted when a build is present (it isn't in local dev — use the Vite
// dev server then). API routes above always take precedence.
const webRoot = env.webDistDir();
if (existsSync(webRoot)) {
  app.use('/*', serveStatic({ root: webRoot }));
  // SPA fallback: any unmatched GET returns index.html for client-side routing.
  app.get('*', serveStatic({ path: `${webRoot}/index.html` }));
  log.info('serving SPA', { webRoot });
}

const port = env.port();
const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info('mailmind-api listening', { port: info.port, env: env.nodeEnv() });
});

// Graceful shutdown: on a redeploy/restart the platform sends SIGTERM. Close the
// server so in-flight requests finish, then exit 0 (which also stops npm from
// reporting the signal as a failed lifecycle script).
function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  server.close(() => process.exit(0));
  // Don't hang forever if connections won't drain.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
