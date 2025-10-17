import { Request, Response, NextFunction } from 'express';
import { ErrorResponse } from '../app.js';

export interface ValidationError extends Error {
  statusCode: number;
  code: string;
}

export function createValidationError(message: string, field?: string): ValidationError {
  const error = new Error(message) as ValidationError;
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

export function validatePagination(req: Request, res: Response, next: NextFunction) {
  const page = req.query.page as string;
  const limit = req.query.limit as string;

  if (page && (isNaN(parseInt(page)) || parseInt(page) < 1)) {
    return next(createValidationError('Page must be a positive integer'));
  }

  if (limit && (isNaN(parseInt(limit)) || parseInt(limit) < 1 || parseInt(limit) > 100)) {
    return next(createValidationError('Limit must be a positive integer between 1 and 100'));
  }

  next();
}

export function validateSorting(validFields: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const sortBy = req.query.sortBy as string;
    const sortOrder = req.query.sortOrder as string;

    if (sortBy && !validFields.includes(sortBy)) {
      return next(createValidationError(`Invalid sort field. Valid fields: ${validFields.join(', ')}`));
    }

    if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
      return next(createValidationError('Sort order must be either "asc" or "desc"'));
    }

    next();
  };
}

export function validateUUID(paramName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const value = req.params[paramName];
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    // For CUID (which Prisma uses by default)
    const cuidRegex = /^c[a-z0-9]{24}$/i;
    
    if (!uuidRegex.test(value) && !cuidRegex.test(value)) {
      return next(createValidationError(`Invalid ${paramName} format`));
    }

    next();
  };
}

export function validateQueryString(req: Request, res: Response, next: NextFunction) {
  const domain = req.query.domain as string;
  const orgName = req.query.orgName as string;

  if (domain && domain.length > 253) {
    return next(createValidationError('Domain name too long (max 253 characters)'));
  }

  if (orgName && orgName.length > 100) {
    return next(createValidationError('Organization name too long (max 100 characters)'));
  }

  // Basic domain validation if provided
  if (domain) {
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!domainRegex.test(domain)) {
      return next(createValidationError('Invalid domain format'));
    }
  }

  next();
}

// Rate limiting middleware (simple in-memory implementation)
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export function rateLimit(maxRequests: number = 100, windowMs: number = 60000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientId = req.ip || 'unknown';
    const now = Date.now();
    
    const clientData = requestCounts.get(clientId);
    
    if (!clientData || now > clientData.resetTime) {
      // Reset or initialize
      requestCounts.set(clientId, {
        count: 1,
        resetTime: now + windowMs,
      });
      return next();
    }
    
    if (clientData.count >= maxRequests) {
      const error: ErrorResponse = {
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests. Limit: ${maxRequests} per ${windowMs / 1000} seconds`,
        },
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      };
      
      return res.status(429).json(error);
    }
    
    clientData.count++;
    next();
  };
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [clientId, data] of requestCounts.entries()) {
    if (now > data.resetTime) {
      requestCounts.delete(clientId);
    }
  }
}, 60000); // Clean up every minute