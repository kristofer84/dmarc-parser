import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import reportsRouter from './routes/reports.js';
import summaryRouter from './routes/summary.js';

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

  // Middleware
  app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
      ? ['http://localhost:5173', 'http://localhost:4173'] // Add your production domains
      : true,
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

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.server.nodeEnv,
    });
  });

  // API routes
  app.use('/api/reports', reportsRouter);
  app.use('/api/summary', summaryRouter);

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