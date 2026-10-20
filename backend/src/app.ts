import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config/env.js';
import reportsRouter from './routes/reports.js';
import summaryRouter from './routes/summary.js';
import sourcesRouter from './routes/sources.js';
import processingLogsRouter from './routes/processingLogs.js';
import forensicsRouter from './routes/forensics.js';
import domainsRouter from './routes/domains.js';
import authRouter from './routes/auth.js';
import brandingRouter from './routes/branding.js';
import usersRouter from './routes/users.js';
import settingsRouter from './routes/settings.js';
import webauthnRouter from './routes/webauthn.js';
import oidcRouter from './routes/oidc.js';
import providersRouter from './routes/providers.js';
import organizationsRouter from './routes/organizations.js';
import orgMailboxesRouter from './routes/orgMailboxes.js';
import dnsAccountsRouter from './routes/dnsAccounts.js';
import auditRouter from './routes/audit.js';
import tlsRptRouter from './routes/tlsRpt.js';
import dnsRouter from './routes/dns.js';
import alertsRouter from './routes/alerts.js';
import { attachOrganization, attachUser, type AuthenticatedRequest } from './middleware/auth.js';
import { auditRequests } from './middleware/audit.js';
import { evaluateProcessingHealth, getProcessingStatus } from './services/processingStatus.js';

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: any;
  };
  timestamp: string;
  path: string;
}

export function createApp(): express.Application {
  const app = express();

  // nginx terminates TLS and forwards; req.secure and req.ip must reflect that.
  // Consequence to remember: the client IP comes from X-Forwarded-For, so this is only
  // safe while the API itself is reachable solely through the proxy (compose binds the
  // port to 127.0.0.1). Set TRUST_PROXY=false if the API is ever exposed directly.
  const trustProxySetting = process.env.TRUST_PROXY?.trim();
  app.set('trust proxy', trustProxySetting === 'false' ? false : true);

  // Origins allowed to call the API from a browser. Same-origin requests (the SPA served
  // by nginx, or curl) carry no Origin header and are always fine; PUBLIC_ORIGIN lists any
  // additional front ends, and the :8097/:4173 dev ports stay allowed.
  const configuredOrigins = (process.env.PUBLIC_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const localFrontendPattern = /:8097$|:4173$/;

  /**
   * The Vite dev-server ports matter only on the machine running the dev server. In
   * production the SPA is served from the same origin as the API, so nothing needs them -
   * and allowing "any host on port 8097" would let someone else's page make browser
   * requests with the session cookie (SameSite=Lax is the only thing stopping it today).
   */
  const isDevOrigin = (origin: string): boolean => {
    if (!localFrontendPattern.test(origin)) {
      return false;
    }
    if (process.env.NODE_ENV !== 'production') {
      return true;
    }
    try {
      const { hostname } = new URL(origin);
      return ['localhost', '127.0.0.1', '::1'].includes(hostname);
    } catch {
      return false;
    }
  };

  // Middleware
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (configuredOrigins.includes(origin) || isDevOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    
    next();
  });

  // Resolve the session cookie (if any) before anything that may care who is asking.
  app.use(attachUser);
  // Resolves the tenant before the routers; a bad X-Org-Id is refused here, not half-applied.
  app.use(attachOrganization);
  // Must come after attachUser (it needs the actor) and before the routers, so it can see
  // req.audit set by a handler and the final status code when the response finishes.
  app.use(auditRequests);

  // Liveness check: the HTTP process is answering.
  app.get('/health/live', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Readiness check: a 200 here means DMARC reports are actually being ingested. A stuck
  // IMAP client or a scheduler that stopped completing cycles returns 503, so the
  // container healthcheck and monitoring no longer report 'healthy' for a parser that
  // has ingested nothing for days.
  app.get('/health', (req: AuthenticatedRequest, res) => {
    const health = evaluateProcessingHealth();
    const status = health.healthy ? 200 : 503;

    const base = {
      status: health.healthy ? 'ok' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.server.nodeEnv,
    };

    // The container healthcheck and uptime monitors are unauthenticated, so they get the
    // verdict and the counters - but not the failure text, which can name internal hosts.
    if (!req.user) {
      const snapshot = getProcessingStatus();
      return res.status(status).json({
        ...base,
        processing: {
          lastCompletedAt: snapshot.lastCompletedAt,
          consecutiveFailures: snapshot.consecutiveFailures,
          // Configuration state, not a secret: a monitor wants to tell "not set up yet"
          // apart from "broken".
          mailboxConfigured: snapshot.mailboxConfigured,
        },
        ...(health.reason ? { reason: health.reason.split('(')[0].trim() } : {}),
      });
    }

    return res.status(status).json({
      ...base,
      processing: getProcessingStatus(),
      ...(health.reason ? { reason: health.reason } : {}),
    });
  });

  // API routes
  app.use('/api/auth', authRouter);
  // Passkeys live under /api/auth/webauthn so that everything which signs someone in is in
  // one place in the route table; the router itself is in routes/webauthn.ts.
  app.use('/api/auth/webauthn', webauthnRouter);
  // OIDC sign-in routes (public) also live under /api/auth - /providers, /oidc/:id/start and
  // /oidc/:id/callback - so everything that signs someone in shares one prefix.
  app.use('/api/auth', oidcRouter);
  // Public on purpose (instance name + accent for the sign-in screen); see routes/branding.ts.
  app.use('/api/branding', brandingRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/summary', summaryRouter);
  app.use('/api/sources', sourcesRouter);
  app.use('/api/processing-logs', processingLogsRouter);
  app.use('/api/forensics', forensicsRouter);
  // TLS-RPT (RFC 8460): SMTP TLS outcomes, read-only and domain-scoped.
  app.use('/api/tlsrpt', tlsRptRouter);
  // Same base as the domains router: the DNS routes are /:name/dns/... and /:name/dmarc/rua,
  // which do not overlap any route there. Mounted first so the more specific paths are tried
  // before the domain detail routes.
  app.use('/api/domains', dnsRouter);
  app.use('/api/domains', domainsRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/settings', settingsRouter);
  // Reading and exporting the audit trail. Administrator-only; see routes/audit.ts.
  app.use('/api/audit', auditRouter);
  // Administrator management of sign-in providers (the public half is under /api/auth).
  app.use('/api/providers', providersRouter);
  // Mailbox routes share the /api/organizations prefix (`/:orgId/mailboxes`) and must be
  // mounted before the organisations router, whose `/:id/members` etc. do not overlap them.
  app.use('/api/organizations', orgMailboxesRouter);
  app.use('/api/organizations', dnsAccountsRouter);
  app.use('/api/organizations', organizationsRouter);

  // All-in-one image: serve the built SPA from the same origin. The port is then the only
  // thing a deployer needs to expose, and browser requests to /api are same-origin, so CORS
  // never enters the picture. Absent in the two-container setup, where nginx does this.
  const staticDir = process.env.STATIC_DIR?.trim();
  const indexPath = staticDir ? join(staticDir, 'index.html') : null;

  if (staticDir && indexPath && existsSync(indexPath)) {
    console.log(`🖼️ Serving the built frontend from ${staticDir}`);
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));

    // Express 5 / path-to-regexp v8: a wildcard must be named, and `*` alone throws.
    // The braces make it optional, so `/` itself is served - `/*splat` alone matches only
    // paths with at least one segment and left the root page answering 404.
    app.get('/{*splat}', (req, res, next) => {
      // Unknown API paths must keep answering JSON, not the SPA shell.
      if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
        next();
        return;
      }
      res.sendFile(indexPath);
    });
  }

  // 404 handler. No path argument: a catch-all middleware is `app.use(handler)` now that
  // bare `'*'` is invalid.
  app.use((req, res) => {
    const error: ErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.originalUrl} not found`,
      },
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
    };
    
    res.status(404).json(error);
  });

  // Global error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('❌ Unhandled error:', err);

    const statusCode = err.statusCode || err.status || 500;
    
    const error: ErrorResponse = {
      error: {
        code: err.code || 'INTERNAL_SERVER_ERROR',
        message: err.message || 'An unexpected error occurred',
        details: config.server.nodeEnv === 'development' ? err.stack : undefined,
      },
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
    };

    res.status(statusCode).json(error);
  });

  return app;
}