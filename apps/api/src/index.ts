import './lib/load-env.js';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { staging } from './routes/staging.js';
import { pipeline } from './routes/pipeline.js';
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
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  }),
);
app.get('/health', (c) => c.json({ status: 'ok', service: 'mailmind-api' }));

app.route('/api', staging);
app.route('/api', pipeline);

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
serve({ fetch: app.fetch, port }, (info) => {
  log.info('mailmind-api listening', { port: info.port, env: env.nodeEnv() });
});

export { app };
