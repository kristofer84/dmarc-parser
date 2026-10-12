import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import reportsRouter from './routes/reports.js';
import summaryRouter from './routes/summary.js';
import processingLogsRouter from './routes/processingLogs.js';
import forensicsRouter from './routes/forensics.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import settingsRouter from './routes/settings.js';
import { attachUser, type AuthenticatedRequest } from './middleware/auth.js';
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

  // Middleware
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (configuredOrigins.includes(origin) || localFrontendPattern.test(origin)) {
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
  app.use('/api/reports', reportsRouter);
  app.use('/api/summary', summaryRouter);
  app.use('/api/processing-logs', processingLogsRouter);
  app.use('/api/forensics', forensicsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/settings', settingsRouter);

  // 404 handler
  app.use('*', (req, res) => {
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