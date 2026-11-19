import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Deps } from './http/context.ts';
import { errorResponse } from './http/errors.ts';
import { authenticate, csrfGuard, requestId, requireUser } from './http/middleware.ts';
import { authRoutes, meRoutes } from './http/routes/auth.ts';
import { connectionRoutes } from './http/routes/connections.ts';
import { scheduleRoutes } from './http/routes/schedules.ts';
import { importRoutes } from './http/routes/imports.ts';
import { demoRoutes, engineRoutes, statelessRoutes } from './http/routes/engine.ts';

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.use('*', requestId());
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
      xFrameOptions: 'DENY',
      crossOriginResourcePolicy: 'cross-origin',
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    }),
  );

  // CORS: only the configured app origins, with credentials (cookie sessions). Everything else gets no CORS headers.
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (deps.config.appOrigins.includes(origin) ? origin : null),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Breakpoint-Client', 'X-Request-Id'],
      exposeHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
      maxAge: 600,
    }),
  );

  const smallBody = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: { code: 'too_large', message: 'Request bodies are limited to 1 MB.' } }, 413) });
  app.use('/api/*', async (c, next) => (/\/import\/|\/engine\//.test(c.req.path) ? next() : smallBody(c, next))); // import + engine routes set their own limits
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/api/*', authenticate());
  app.use('/api/*', csrfGuard());
  app.use('/api/schedules/*', requireUser());
  app.use('/api/runs/*', requireUser());

  const health = (c: import('hono').Context<AppEnv>) => c.json({ ok: true, service: 'breakpoint-api', time: deps.now().toISOString() });
  app.get('/health', health);
  app.get('/api/health', health);

  app.route('/api/auth', authRoutes());
  app.route('/api/me', meRoutes());
  app.route('/api/connections', connectionRoutes());
  app.route('/api/schedules', scheduleRoutes());
  app.route('/api/schedules', importRoutes());
  app.route('/api', engineRoutes());
  app.route('/api', statelessRoutes());
  app.route('/api', demoRoutes());

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.', requestId: c.get('requestId') } }, 404));
  app.onError((e, c) => errorResponse(c, e));
  return app;
}
